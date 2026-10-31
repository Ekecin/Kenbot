// Voice helpers built on the browser's own Web Speech APIs.
// No extra keys or services needed. Works in Chrome, Edge and Safari.
// (Firefox can speak but can't listen, so the mic buttons are hidden there.)

/* ───────── Listening (speech → text) ───────── */

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
export const voiceOutputSupported = () =>
  typeof window !== "undefined" && "speechSynthesis" in window;

export type Listener = { start: () => void; stop: () => void; abort: () => void };

export function createListener(opts: {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd?: () => void;
  onError?: (code: string) => void;
}): Listener | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = false;
  rec.interimResults = true;

  let finalText = "";
  let delivered = false;
  let aborted = false;
  let retryWithEnglish = false;

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onInterim?.((finalText + interim).trim());
  };

  rec.onerror = (e) => {
    // Some regional languages (e.g. en-NG) aren't supported everywhere. Fall back to US English.
    if (e.error === "language-not-supported" && rec.lang !== "en-US") {
      rec.lang = "en-US";
      retryWithEnglish = true;
      return;
    }
    opts.onError?.(e.error);
  };

  rec.onend = () => {
    if (aborted) return;
    if (retryWithEnglish) {
      retryWithEnglish = false;
      try {
        rec.start();
      } catch {
        opts.onEnd?.();
      }
      return;
    }
    if (!delivered) {
      delivered = true;
      const text = finalText.trim();
      if (text) opts.onFinal(text);
    }
    opts.onEnd?.();
  };

  return {
    start: () => rec.start(),
    stop: () => rec.stop(),
    abort: () => {
      aborted = true;
      try {
        rec.abort();
      } catch {
        // Nothing to abort.
      }
    },
  };
}

export function voiceErrorMessage(
  code: string,
  context: "dictation" | "conversation",
): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "no-speech":
      return context === "dictation"
        ? "I didn't catch anything. Tap the mic and try again."
        : null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it in your browser's site settings, then try again.";
    case "audio-capture":
      return "I can't find a microphone. Check that one is connected and try again.";
    case "network":
      return "Voice recognition needs an internet connection. Check yours and try again.";
    default:
      return "Voice input hit a snag. Please try again.";
  }
}

/* ───────── Speaking (text → speech) ───────── */

// Turns markdown into plain words that sound natural when read aloud.
export function cleanForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " I've put the code in the chat. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~>#|]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type Speaker = {
  /** Give it all the reply text received so far; it speaks each new finished sentence. */
  feed: (rawText: string) => void;
  /** Call when the reply is complete. `onIdle` runs once everything has been spoken. */
  end: (onIdle: () => void) => void;
  cancel: () => void;
  /** Call from a tap or click so mobile browsers allow speech later. */
  unlock: () => void;
};

export function createSpeaker(opts: { onStart?: () => void } = {}): Speaker | null {
  if (!voiceOutputSupported()) return null;
  const synth = window.speechSynthesis;

  let session = 0;
  let raw = "";
  let spokenUpTo = 0;
  let pending = 0;
  let finished = false;
  let idleCb: (() => void) | null = null;
  let startFired = false;

  function pickVoice(lang: string): SpeechSynthesisVoice | null {
    const voices = synth.getVoices();
    const base = lang.slice(0, 2).toLowerCase();
    const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
    return (
      matching.find((v) => /natural|google|online|samantha|aria|jenny|ava|serena/i.test(v.name)) ??
      matching[0] ??
      null
    );
  }

  function checkIdle() {
    if (finished && pending === 0 && idleCb) {
      const cb = idleCb;
      idleCb = null;
      cb();
    }
  }

  function enqueue(chunk: string) {
    const text = cleanForSpeech(chunk);
    if (!text) return;
    const mine = session;
    const lang = navigator.language || "en-US";
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.rate = 1.03;
    u.pitch = 1.05;
    pending += 1;
    u.onstart = () => {
      if (mine !== session || startFired) return;
      startFired = true;
      opts.onStart?.();
    };
    const done = () => {
      if (mine !== session) return;
      pending = Math.max(0, pending - 1);
      checkIdle();
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }

  // Speak sentence by sentence so replies start quickly and long text never cuts off.
  function flush(final: boolean) {
    const re = final
      ? /^([\s\S]*?(?:[.!?…]+["')\]]*(?=\s|$)|\n))/
      : /^([\s\S]*?(?:[.!?…]+["')\]]*(?=\s)|\n))/;
    let rest = raw.slice(spokenUpTo);
    for (;;) {
      const m = re.exec(rest);
      if (!m || m[0].length === 0) break;
      enqueue(m[0]);
      spokenUpTo += m[0].length;
      rest = raw.slice(spokenUpTo);
    }
    if (final && rest.trim()) {
      enqueue(rest);
      spokenUpTo = raw.length;
    }
  }

  return {
    feed(text) {
      raw = text;
      flush(false);
    },
    end(onIdle) {
      finished = true;
      idleCb = onIdle;
      flush(true);
      checkIdle();
    },
    cancel() {
      session += 1;
      synth.cancel();
      raw = "";
      spokenUpTo = 0;
      pending = 0;
      finished = false;
      idleCb = null;
      startFired = false;
    },
    unlock() {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      synth.speak(u);
    },
  };
}
