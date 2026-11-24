// The built-in browser voice (Web Speech API). Used when the neural voice is turned off,
// unavailable, over its limit, or when a request fails. Quality depends on the device.
import { BROWSER_VOICE } from "./profile";
import { SentenceChunker } from "./speechText";
import type { SpeechEngine, SpeechEvents, VoicePace } from "./types";

export type BrowserEngine = SpeechEngine & {
  /** Speak one piece of already-prepared text and resolve when it has finished (or was cancelled). */
  speakChunk(text: string): Promise<void>;
};

const GOOD_VOICE = /natural|neural|online|enhanced|premium|siri|samantha|ava|serena|allison|aria|jenny|google/i;
const POOR_VOICE = /compact|espeak|novelty|zarvox|whisper|bells|organ/i;

export function createBrowserEngine(events: SpeechEvents = {}, initialPace: VoicePace = "normal"): BrowserEngine | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const synth = window.speechSynthesis;

  let pace = initialPace;
  let session = 0;
  let raw = "";
  let spoken = "";
  let pending = 0;
  let finished = false;
  let idleCb: (() => void) | null = null;
  let startFired = false;
  let requestFired = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<() => void>();
  const chunker = new SentenceChunker({ target: 90, max: 200 }); // shorter: some browsers stop long utterances
  const voiceCache = new Map<string, SpeechSynthesisVoice | null>();

  const lang = () => navigator.language || "en-US";

  function pickVoice(language: string): SpeechSynthesisVoice | null {
    const base = language.slice(0, 2).toLowerCase();
    if (voiceCache.has(base)) return voiceCache.get(base) ?? null;
    const voices = synth.getVoices();
    if (voices.length === 0) return null; // not loaded yet; try again next time
    let best: SpeechSynthesisVoice | null = null;
    let bestScore = -Infinity;
    for (const v of voices) {
      if (!v.lang.toLowerCase().startsWith(base)) continue;
      let score = 0;
      if (v.lang.toLowerCase() === language.toLowerCase()) score += 2;
      if (GOOD_VOICE.test(v.name)) score += 5;
      if (POOR_VOICE.test(v.name)) score -= 6;
      if (!v.localService) score += 1;
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    voiceCache.set(base, best);
    return best;
  }

  synth.addEventListener?.("voiceschanged", () => voiceCache.clear());

  function checkIdle() {
    if (finished && pending === 0 && idleCb) {
      const cb = idleCb;
      idleCb = null;
      events.onMetric?.("finished");
      cb();
    }
  }

  function speakNow(text: string, onDone: () => void) {
    const language = lang();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language;
    const voice = pickVoice(language);
    if (voice) u.voice = voice;
    u.rate = BROWSER_VOICE.rate[pace];
    u.pitch = BROWSER_VOICE.pitch;
    const mine = session;
    u.onstart = () => {
      if (mine !== session || startFired) return;
      startFired = true;
      events.onMetric?.("playbackStart");
      events.onStart?.();
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onDone();
    };
    u.onend = finish;
    u.onerror = finish;
    if (!requestFired) {
      requestFired = true;
      events.onMetric?.("ttsRequested");
      events.onMetric?.("firstAudioData");
    }
    synth.speak(u);
  }

  function enqueue(text: string) {
    if (!text) return;
    const mine = session;
    spoken += (spoken ? " " : "") + text;
    pending += 1;
    speakNow(text, () => {
      if (mine !== session) return;
      pending = Math.max(0, pending - 1);
      checkIdle();
    });
  }

  function clearFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  }

  function resetReply() {
    session += 1;
    raw = "";
    spoken = "";
    pending = 0;
    finished = false;
    idleCb = null;
    startFired = false;
    requestFired = false;
    chunker.reset();
    clearFlush();
  }

  const engine: BrowserEngine = {
    provider: "browser",
    feed(text) {
      if (finished) resetReply(); // a new reply started without cancel()
      raw = text;
      for (const c of chunker.push(raw, false)) enqueue(c.text);
      clearFlush();
      flushTimer = setTimeout(() => {
        for (const c of chunker.flushPending()) enqueue(c.text);
      }, 300);
    },
    end(onIdle) {
      clearFlush();
      finished = true;
      idleCb = onIdle;
      for (const c of chunker.push(raw, true)) enqueue(c.text);
      checkIdle();
    },
    cancel() {
      synth.cancel();
      resetReply();
      waiters.forEach((resolve) => resolve());
      waiters.clear();
    },
    unlock() {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      synth.speak(u);
    },
    isActive() {
      return pending > 0 || synth.speaking;
    },
    spokenText() {
      return spoken;
    },
    setPace(p) {
      pace = p;
    },
    dispose() {
      engine.cancel();
    },
    speakChunk(text) {
      return new Promise<void>((resolve) => {
        waiters.add(resolve);
        speakNow(text, () => {
          waiters.delete(resolve);
          resolve();
        });
      });
    },
  };
  return engine;
}
