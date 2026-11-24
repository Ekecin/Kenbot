// Speech recognition (speech → text) built on the browser's Web Speech API.
//
// Compared with a bare SpeechRecognition this adds:
//  - end-of-turn detection from interim results (so there's no long wait after you stop talking),
//  - a continuous mode that keeps ONE microphone session open across a whole conversation,
//  - automatic restarts with back-off, language fallbacks and clear error codes,
//  - "hold / take over" controls so the app can listen for interruptions while KenBot speaks.
//
// Text-to-speech lives in lib/tts/.

export { prepareForSpeech as cleanForSpeech } from "./tts/speechText";
export { shouldInterrupt, stripEchoPrefix } from "./tts/echo";
import { stripEchoPrefix } from "./tts/echo";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceInputSupported = () => getRecognitionCtor() !== null;
export const voiceOutputSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** Languages to try, in order: a saved choice (localStorage "kenbot:lang"), the browser's, then US English. */
export function preferredLanguages(): string[] {
  const list: string[] = [];
  try {
    const saved = localStorage.getItem("kenbot:lang");
    if (saved) list.push(saved);
  } catch {
    // storage unavailable
  }
  if (typeof navigator !== "undefined") {
    if (navigator.language) list.push(navigator.language);
    for (const l of navigator.languages ?? []) list.push(l);
  }
  list.push("en-US");
  return list.filter((l, i) => l && list.indexOf(l) === i);
}

export type ListenerOptions = {
  /** Keep one session open across many turns (voice mode). Default: one turn, then stop (dictation). */
  continuous?: boolean;
  /** Silence after the last change in the transcript that counts as the end of a turn. Default 900 ms. */
  endOfTurnMs?: number;
  /** Shorter wait used once the browser itself has marked the speech as final. Default 250 ms. */
  finalEndMs?: number;
  /** When to call onLikelyEnd (the person has probably finished). Default 450 ms. */
  likelyEndMs?: number;
  languages?: string[];
  onSpeechStart?: () => void;
  onInterim?: (text: string, info: { isFinal: boolean; held: boolean }) => void;
  onLikelyEnd?: (text: string) => void;
  onFinal: (text: string, info: { speechEndedAt: number }) => void;
  /** A listening round passed without any speech. */
  onQuiet?: () => void;
  /** The listener stopped for good (nothing more will arrive). */
  onEnd?: () => void;
  onError?: (code: string) => void;
};

export type Listener = {
  start: () => void;
  /** Finish gracefully: deliver anything already heard, then stop. */
  stop: () => void;
  /** Stop immediately and discard everything. No callbacks. */
  abort: () => void;
  /** Turn the microphone off without discarding settings (use resume() to continue). */
  pause: () => void;
  resume: () => void;
  /** Keep listening and reporting, but never deliver a turn (KenBot is thinking or speaking). */
  holdCommits: () => void;
  /** Go back to normal listening, discarding anything heard while held. */
  releaseCommits: () => void;
  /** Deliver what has been heard so far right now (the person tapped "I'm done"). */
  commitNow: () => void;
  /** The person interrupted: stop holding, KEEP what they are saying, and ignore KenBot's own words. */
  takeOver: (kenbotSpoke: string) => void;
  isRunning: () => boolean;
};

export function createListener(opts: ListenerOptions): Listener | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const continuous = !!opts.continuous;
  const endMs = opts.endOfTurnMs ?? 900;
  const finalMs = opts.finalEndMs ?? 250;
  const likelyMs = opts.likelyEndMs ?? 450;
  const languages = opts.languages?.length ? opts.languages : preferredLanguages();

  let rec: Recognition | null = null;
  let active = false; // the microphone should be on
  let sessionId = 0;
  let langIndex = 0;
  let consumed = 0; // results already delivered (continuous sessions keep a growing list)
  let resultsLength = 0;
  let turnText = "";
  let turnFinal = false;
  let speechStarted = false;
  let delivered = false; // non-continuous: this session already delivered its turn
  let lastChangeAt = 0;
  let held = false;
  let echoSpoken = "";
  let sessionHadSpeech = false;
  let sessionStartedAt = 0;
  let quickFails = 0;
  let networkRetries = 0;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let likelyTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (endTimer) clearTimeout(endTimer);
    if (likelyTimer) clearTimeout(likelyTimer);
    endTimer = likelyTimer = null;
  };

  function commit() {
    clearTimers();
    if (held) return;
    let text = turnText.trim();
    if (echoSpoken) text = stripEchoPrefix(text, echoSpoken).trim();
    turnText = "";
    turnFinal = false;
    speechStarted = false;
    echoSpoken = "";
    consumed = resultsLength;
    if (!text) return;
    const endedAt = lastChangeAt;
    if (continuous) {
      opts.onFinal(text, { speechEndedAt: endedAt });
    } else if (!delivered) {
      delivered = true;
      try {
        rec?.stop(); // we have what we need; don't wait for the browser to time out
      } catch {
        // already stopped
      }
      opts.onFinal(text, { speechEndedAt: endedAt });
    }
  }

  function schedule() {
    clearTimers();
    const wait = turnFinal ? finalMs : endMs;
    endTimer = setTimeout(commit, wait);
    if (opts.onLikelyEnd && !turnFinal) {
      likelyTimer = setTimeout(() => opts.onLikelyEnd?.(turnText), Math.min(likelyMs, wait));
    }
  }

  function handleResult(e: RecognitionEvent) {
    resultsLength = e.results.length;
    let text = "";
    let allFinal = true;
    for (let i = consumed; i < e.results.length; i++) {
      const r = e.results[i];
      text += r[0].transcript;
      if (!r.isFinal) allFinal = false;
    }
    text = text.trim();
    if (!text) return;
    if (text === turnText && allFinal === turnFinal) return; // nothing new
    turnText = text;
    turnFinal = allFinal;
    lastChangeAt = Date.now();
    sessionHadSpeech = true;
    if (!held && !speechStarted) {
      speechStarted = true;
      opts.onSpeechStart?.();
    }
    opts.onInterim?.(text, { isFinal: allFinal, held });
    if (!held) schedule();
  }

  function startSession() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const id = ++sessionId;
    const r = new Ctor!();
    rec = r;
    r.lang = languages[langIndex] ?? "en-US";
    r.continuous = continuous;
    r.interimResults = true;
    consumed = 0;
    resultsLength = 0;
    turnText = "";
    turnFinal = false;
    speechStarted = false;
    delivered = false;
    sessionHadSpeech = false;
    sessionStartedAt = Date.now();
    r.onresult = (e) => {
      if (id === sessionId) handleResult(e);
    };
    r.onerror = (e) => {
      if (id === sessionId) handleError(e.error);
    };
    r.onend = () => {
      if (id === sessionId) handleEnd();
    };
    try {
      r.start();
    } catch {
      // InvalidStateError: a session is already running
    }
  }

  function restartSoon(delay: number) {
    sessionId++; // ignore anything the old session still reports
    clearTimers();
    try {
      rec?.abort();
    } catch {
      // nothing to abort
    }
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (active) startSession();
    }, delay);
  }

  function fatal(code: string) {
    active = false;
    clearTimers();
    opts.onError?.(code);
  }

  function handleError(code: string) {
    switch (code) {
      case "aborted":
      case "no-speech": // counted as a quiet round when the session ends
        return;
      case "language-not-supported":
        if (langIndex < languages.length - 1) {
          langIndex++;
          restartSoon(0);
          return;
        }
        break;
      case "network":
        if (networkRetries < 2) {
          networkRetries++;
          restartSoon(500 * networkRetries);
          return;
        }
        break;
      default:
        break;
    }
    fatal(code);
  }

  function handleEnd() {
    clearTimers();
    if (turnText.trim() && !held) commit(); // deliver what was heard even if the session ended early
    if (!sessionHadSpeech) opts.onQuiet?.();
    if (!active || !continuous) {
      active = false;
      opts.onEnd?.();
      return;
    }
    const lived = Date.now() - sessionStartedAt;
    quickFails = lived < 1200 ? quickFails + 1 : 0;
    if (quickFails >= 4) {
      fatal("unstable"); // the browser keeps ending the session immediately
      return;
    }
    networkRetries = 0;
    restartSoon(lived < 1200 ? 400 : 120);
  }

  const listener: Listener = {
    start() {
      if (active) return;
      active = true;
      quickFails = 0;
      networkRetries = 0;
      startSession();
    },
    stop() {
      if (!rec) return;
      active = false;
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    },
    abort() {
      active = false;
      sessionId++;
      clearTimers();
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      try {
        rec?.abort();
      } catch {
        // nothing to abort
      }
      turnText = "";
      held = false;
      echoSpoken = "";
    },
    pause() {
      active = false;
      sessionId++;
      clearTimers();
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      try {
        rec?.abort();
      } catch {
        // nothing to abort
      }
      turnText = "";
    },
    resume() {
      held = false;
      echoSpoken = "";
      listener.start();
    },
    holdCommits() {
      held = true;
      clearTimers();
      turnText = "";
      turnFinal = false;
      speechStarted = false;
      echoSpoken = "";
      consumed = resultsLength;
    },
    releaseCommits() {
      if (!held) return;
      held = false;
      clearTimers();
      turnText = "";
      turnFinal = false;
      speechStarted = false;
      echoSpoken = "";
      consumed = resultsLength;
    },
    commitNow() {
      commit();
    },
    takeOver(kenbotSpoke) {
      if (!held) return;
      held = false;
      echoSpoken = kenbotSpoke;
      speechStarted = true;
      schedule();
    },
    isRunning() {
      return active;
    },
  };
  return listener;
}

export function voiceErrorMessage(code: string, context: "dictation" | "conversation"): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "no-speech":
      return context === "dictation" ? "I didn't catch anything. Tap the mic and try again." : null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it in your browser's site settings, then try again.";
    case "audio-capture":
      return "I can't find a microphone. Check that one is connected and try again.";
    case "network":
      return "Voice recognition needs an internet connection. Check yours and try again.";
    case "unstable":
      return "Voice input keeps stopping on this device. Try again in a moment, or type instead.";
    default:
      return "Voice input hit a snag. Please try again.";
  }
}
