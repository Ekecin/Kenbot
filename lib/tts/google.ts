// Neural voice: Gemini TTS through KenBot's own /api/tts route (the API key never reaches the browser).
//
// Pipeline for one reply:
//   text stream → sentence chunker → one streaming request per chunk (max 2 at a time)
//   → raw 24 kHz PCM → silence trimming → gapless Web Audio scheduling (with natural pauses)
// If anything fails, the built-in browser voice takes over for the rest of the reply.
import type { BrowserEngine } from "./browser";
import { applyFade, concatFloat32, firstSoundIndex, lastSoundIndex, pcm16ToFloat32, SAMPLE_RATE } from "./pcm";
import { SentenceChunker, type SpeechChunk } from "./speechText";
import type { SpeechEngine, SpeechEvents, VoicePace } from "./types";

/* ───────── Shared health of the neural voice (survives between replies) ───────── */

const health = {
  until: 0,
  fails: 0,
  available(): boolean {
    return Date.now() >= this.until;
  },
  ok(): void {
    this.fails = 0;
  },
  fail(code: string): void {
    if (code === "tts_not_configured" || code === "tts_model_not_found" || code === "tts_auth" || code === "tts_bad_request") {
      this.until = Number.POSITIVE_INFINITY; // won't get better until the page is reloaded
    } else if (code === "tts_limit") {
      this.until = Date.now() + 10 * 60 * 1000;
    } else if (++this.fails >= 2) {
      this.until = Date.now() + 3 * 60 * 1000;
    }
  },
};

class TtsError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/* ───────── Tuning ───────── */

const MAX_IN_FLIGHT = 2; // concurrent synthesis requests for one reply
const FIRST_BYTE_TIMEOUT_MS = 7000;
const SILENCE = 0.012; // amplitude treated as silence when trimming
const HEAD_WAIT = 2400; // 100 ms decoded before deciding how much leading silence to cut
const HEAD_SCAN = 12000; // look for the first sound within 500 ms
const HEAD_KEEP = 480; // keep 20 ms before the first sound
const HOLD = 7200; // hold back 300 ms so trailing silence can be trimmed when the clip ends
const HOLD_FIRST = 2400; // the very first piece of a reply is released sooner (100 ms hold) for a faster start
const MIN_PIECE = 2400; // schedule audio in pieces of at least 100 ms
const TAIL_KEEP = 1920; // keep 80 ms after the last sound
const LEAD_SECONDS = 0.03; // how far ahead of "now" playback is scheduled

type Job = {
  id: number;
  text: string;
  pauseAfterMs: number;
  kind: "neural" | "browser" | "skip";
  controller: AbortController;
  started: boolean;
  failed: boolean;
  done: boolean;
  gotAudio: boolean;
  carry: Uint8Array | null;
  headParts: Float32Array[];
  headLen: number;
  headDone: boolean;
  pending: Float32Array[];
  pendingLen: number;
  ready: Float32Array[];
  firstPiece: boolean;
  releasedAny: boolean;
  browserStarted: boolean;
  browserDone: boolean;
};

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function neuralVoiceSupported(): boolean {
  return audioContextCtor() !== null && typeof fetch === "function";
}

export function createGeminiEngine(opts: {
  events?: SpeechEvents;
  pace?: VoicePace;
  browser: BrowserEngine | null;
  endpoint?: string;
}): SpeechEngine {
  const events = opts.events ?? {};
  const browser = opts.browser;
  const endpoint = opts.endpoint ?? "/api/tts";
  const Ctor = audioContextCtor();

  let pace: VoicePace = opts.pace ?? "normal";
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let nextTime = 0;
  const sources = new Set<AudioBufferSourceNode>();

  let session = 0;
  let jobs: Job[] = [];
  let playIdx = 0;
  let seq = 0;
  let firstJobId = -1; // id of the first job in the current reply
  let degraded = false;
  let raw = "";
  let spoken = "";
  let finished = false;
  let idleCb: (() => void) | null = null;
  let startFired = false;
  let requestFired = false;
  let audioFired = false;
  let scheduledAny = false;
  let pendingPause = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const chunker = new SentenceChunker();

  /* ───────── Audio output ───────── */

  function ensureCtx(): AudioContext | null {
    if (!ctx) {
      if (!Ctor) return null;
      try {
        ctx = new Ctor({ latencyHint: "interactive" });
      } catch {
        ctx = new Ctor();
      }
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  }

  function schedule(samples: Float32Array, job: Job): void {
    const c = ensureCtx();
    if (!c || !master || samples.length === 0) return;

    if (job.firstPiece) {
      job.firstPiece = false;
      applyFade(samples, 96, 0); // 4 ms fade-in avoids a click where chunks join
      if (pendingPause > 0 && nextTime > c.currentTime) nextTime += pendingPause / 1000;
      pendingPause = 0;
    }

    const buffer = c.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(master);

    const earliest = c.currentTime + LEAD_SECONDS;
    if (scheduledAny && nextTime < c.currentTime) {
      // The previous audio ended before this arrived: an audible, unplanned gap.
      events.onMetric?.("gap", (earliest - nextTime) * 1000);
    }
    const startAt = Math.max(nextTime, earliest);
    src.start(startAt);
    nextTime = startAt + buffer.duration;
    scheduledAny = true;

    if (!startFired) {
      startFired = true;
      const mine = session;
      setTimeout(() => {
        if (mine !== session) return;
        events.onMetric?.("playbackStart");
        events.onStart?.();
      }, Math.max(0, (startAt - c.currentTime) * 1000));
    }

    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      armIdleCheck();
    };
  }

  function stopAudio(): void {
    if (!ctx || !master) return;
    const old = master;
    const olds = Array.from(sources);
    sources.clear();
    old.gain.cancelScheduledValues(ctx.currentTime);
    old.gain.setTargetAtTime(0, ctx.currentTime, 0.01); // quick fade so there is no click
    setTimeout(() => {
      olds.forEach((s) => {
        try {
          s.stop();
        } catch {
          // already stopped
        }
      });
      try {
        old.disconnect();
      } catch {
        // already disconnected
      }
    }, 80);
    master = ctx.createGain();
    master.connect(ctx.destination);
  }

  /* ───────── Decoding one synthesis response ───────── */

  function pushPending(job: Job, samples: Float32Array): void {
    if (samples.length === 0) return;
    job.pending.push(samples);
    job.pendingLen += samples.length;
    const hold = job.id === firstJobId && !job.releasedAny ? HOLD_FIRST : HOLD;
    if (job.pendingLen - hold >= MIN_PIECE) {
      const all = concatFloat32(job.pending);
      const cut = all.length - hold;
      job.ready.push(all.slice(0, cut));
      job.pending = [all.slice(cut)];
      job.pendingLen = hold;
      job.releasedAny = true;
    }
  }

  function trimHead(job: Job): void {
    const all = concatFloat32(job.headParts);
    job.headParts = [];
    job.headLen = 0;
    job.headDone = true;
    if (all.length === 0) return;
    const idx = firstSoundIndex(all, SILENCE, HEAD_SCAN);
    const drop = idx === -1 ? Math.max(0, Math.min(all.length, HEAD_SCAN) - HEAD_KEEP) : Math.max(0, idx - HEAD_KEEP);
    pushPending(job, all.subarray(drop));
  }

  function ingest(job: Job, samples: Float32Array): void {
    if (samples.length) job.gotAudio = true;
    if (!job.headDone) {
      job.headParts.push(samples);
      job.headLen += samples.length;
      if (job.headLen >= HEAD_WAIT) trimHead(job);
      return;
    }
    pushPending(job, samples);
  }

  function finishJob(job: Job): void {
    if (!job.headDone) trimHead(job);
    if (job.pendingLen > 0) {
      const all = concatFloat32(job.pending);
      job.pending = [];
      job.pendingLen = 0;
      const last = lastSoundIndex(all, SILENCE);
      const keep = last === -1 ? 0 : Math.min(all.length, last + TAIL_KEEP + 1);
      if (keep > 0) {
        const tail = all.slice(0, keep);
        applyFade(tail, 0, 144); // 6 ms fade-out
        job.ready.push(tail);
      }
    }
    job.done = true;
  }

  async function runFetch(job: Job): Promise<void> {
    job.started = true;
    const mine = session;
    if (!requestFired) {
      requestFired = true;
      events.onMetric?.("ttsRequested");
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      job.controller.abort();
    }, FIRST_BYTE_TIMEOUT_MS);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: job.text, pace }),
        signal: job.controller.signal,
      });
      if (!res.ok || !res.body) {
        let code = "tts_http_" + res.status;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          // not JSON
        }
        throw new TtsError(code);
      }

      const reader = res.body.getReader();
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (mine !== session) {
          reader.cancel().catch(() => {});
          return;
        }
        if (done) break;
        if (first) {
          first = false;
          clearTimeout(timer);
          if (!audioFired) {
            audioFired = true;
            events.onMetric?.("firstAudioData");
          }
        }
        const decoded = pcm16ToFloat32(value, job.carry);
        job.carry = decoded.carry;
        ingest(job, decoded.samples);
        drain();
      }
      finishJob(job);
      if (job.gotAudio) health.ok();
      else throw new TtsError("tts_empty");
    } catch (e) {
      if (mine !== session) return; // cancelled on purpose
      const code = timedOut ? "tts_timeout" : e instanceof TtsError ? e.code : "tts_network";
      health.fail(code);
      degraded = true;
      events.onFallback?.(code);
      if (job.gotAudio) finishJob(job); // play what we already have rather than repeat the sentence
      else job.failed = true;
    } finally {
      clearTimeout(timer);
      if (mine === session) {
        pump();
        drain();
      }
    }
  }

  function pump(): void {
    let inFlight = jobs.filter((j) => j.kind === "neural" && j.started && !j.done && !j.failed).length;
    for (const job of jobs) {
      if (inFlight >= MAX_IN_FLIGHT) break;
      if (job.kind === "neural" && !job.started && !job.failed) {
        void runFetch(job);
        inFlight++;
      }
    }
  }

  function createJob(chunk: SpeechChunk): void {
    spoken += (spoken ? " " : "") + chunk.text;
    const neural = !degraded && health.available();
    const job: Job = {
      id: ++seq,
      text: chunk.text,
      pauseAfterMs: chunk.pauseAfterMs,
      kind: neural ? "neural" : browser ? "browser" : "skip",
      controller: new AbortController(),
      started: false,
      failed: false,
      done: false,
      gotAudio: false,
      carry: null,
      headParts: [],
      headLen: 0,
      headDone: false,
      pending: [],
      pendingLen: 0,
      ready: [],
      firstPiece: true,
      releasedAny: false,
      browserStarted: false,
      browserDone: false,
    };
    if (jobs.length === 0) firstJobId = job.id;
    jobs.push(job);
    if (!neural && !degraded) events.onFallback?.("tts_unavailable");
    degraded = degraded || !neural;
    pump();
    drain();
  }

  /* ───────── Playback order ───────── */

  function degradeFrom(index: number): void {
    degraded = true;
    for (let i = index; i < jobs.length; i++) {
      const j = jobs[i];
      if (j.kind === "neural" && !j.done) {
        j.controller.abort();
        j.kind = browser ? "browser" : "skip";
      }
    }
  }

  function armDrainTimer(ms: number): void {
    if (drainTimer) clearTimeout(drainTimer);
    const mine = session;
    drainTimer = setTimeout(() => {
      if (mine === session) drain();
    }, ms);
  }

  function drain(): void {
    while (playIdx < jobs.length) {
      const job = jobs[playIdx];
      if (job.kind === "skip") {
        playIdx++;
        continue;
      }
      if (job.kind === "browser") {
        if (!job.browserStarted) {
          // Let neural audio that is already scheduled finish, then use the built-in voice.
          if (ctx && nextTime > ctx.currentTime + 0.02) {
            armDrainTimer((nextTime - ctx.currentTime) * 1000 + 30);
            return;
          }
          job.browserStarted = true;
          const mine = session;
          const speak = browser ? browser.speakChunk(job.text) : Promise.resolve();
          void speak.then(() => {
            if (mine !== session) return;
            job.browserDone = true;
            drain();
          });
        }
        if (!job.browserDone) return;
        playIdx++;
        continue;
      }
      if (job.failed) {
        degradeFrom(playIdx);
        continue;
      }
      while (job.ready.length) schedule(job.ready.shift() as Float32Array, job);
      if (!job.done) return;
      pendingPause = job.pauseAfterMs;
      playIdx++;
    }
    armIdleCheck();
    checkIdle();
  }

  /* ───────── Finishing ───────── */

  function armIdleCheck(): void {
    if (!finished) return;
    if (idleTimer) clearTimeout(idleTimer);
    const wait = ctx ? Math.max(0, (nextTime - ctx.currentTime) * 1000) : 0;
    const mine = session;
    idleTimer = setTimeout(() => {
      if (mine === session) checkIdle();
    }, wait + 40);
  }

  function checkIdle(): void {
    if (!finished || !idleCb || playIdx < jobs.length) return;
    if (ctx && nextTime > ctx.currentTime + 0.02) {
      armIdleCheck();
      return;
    }
    const cb = idleCb;
    events.onMetric?.("finished");
    resetReply(false);
    cb();
  }

  function clearTimers(): void {
    if (flushTimer) clearTimeout(flushTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (drainTimer) clearTimeout(drainTimer);
    flushTimer = idleTimer = drainTimer = null;
  }

  function resetReply(abortWork: boolean): void {
    session += 1;
    clearTimers();
    if (abortWork) for (const j of jobs) j.controller.abort();
    jobs = [];
    firstJobId = -1;
    playIdx = 0;
    raw = "";
    spoken = "";
    finished = false;
    idleCb = null;
    degraded = false;
    startFired = false;
    requestFired = false;
    audioFired = false;
    scheduledAny = false;
    pendingPause = 0;
    nextTime = 0;
    chunker.reset();
  }

  /* ───────── Public API ───────── */

  return {
    provider: "gemini",
    feed(text) {
      if (finished) resetReply(false); // a new reply began without cancel()
      raw = text;
      for (const c of chunker.push(raw, false)) createJob(c);
      if (flushTimer) clearTimeout(flushTimer);
      const mine = session;
      flushTimer = setTimeout(() => {
        if (mine !== session) return;
        for (const c of chunker.flushPending()) createJob(c);
      }, 300);
    },
    end(onIdle) {
      if (flushTimer) clearTimeout(flushTimer);
      finished = true;
      idleCb = onIdle;
      for (const c of chunker.push(raw, true)) createJob(c);
      drain();
    },
    cancel() {
      resetReply(true);
      stopAudio();
      browser?.cancel();
    },
    unlock() {
      const c = ensureCtx();
      if (c) {
        const silent = c.createBuffer(1, 1, SAMPLE_RATE);
        const s = c.createBufferSource();
        s.buffer = silent;
        s.connect(c.destination);
        s.start(0);
      }
      browser?.unlock();
    },
    isActive() {
      return jobs.length > playIdx || sources.size > 0 || (ctx !== null && nextTime > ctx.currentTime);
    },
    spokenText() {
      return spoken;
    },
    setPace(p) {
      pace = p;
      browser?.setPace(p);
    },
    dispose() {
      resetReply(true);
      stopAudio();
      browser?.dispose();
      void ctx?.close().catch(() => {});
      ctx = null;
      master = null;
    },
  };
}
