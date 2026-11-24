// Shared speech-engine types. A "speech engine" turns streamed reply text into audible speech.
// KenBot ships two: a neural engine (Gemini TTS, via the server) and the browser's built-in voice.

export type TtsProviderId = "gemini" | "browser";
export type VoicePace = "slow" | "normal" | "fast";

/** Points in a spoken reply that the performance monitor records. */
export type SpeechMetric =
  | "ttsRequested" // first synthesis request for this reply was sent
  | "firstAudioData" // first audio bytes arrived (or the browser accepted the first utterance)
  | "playbackStart" // sound actually started coming out of the speakers
  | "gap" // an unplanned gap between two chunks (value = milliseconds)
  | "finished"; // everything has been spoken

export interface SpeechEvents {
  /** Called once per reply when the first sound is playing. */
  onStart?: () => void;
  onMetric?: (name: SpeechMetric, value?: number) => void;
  /** Called when the neural voice failed and the built-in voice took over. */
  onFallback?: (reason: string) => void;
}

export interface SpeechEngine {
  readonly provider: string;
  /** Give it ALL the reply text received so far; it speaks each newly finished phrase. */
  feed(rawText: string): void;
  /** The reply text is complete. `onIdle` runs once everything has been spoken. */
  end(onIdle: () => void): void;
  /** Stop immediately: silence audio, abort requests, clear every queue. */
  cancel(): void;
  /** Call from a tap or click so mobile browsers allow audio. */
  unlock(): void;
  /** True while anything is queued, loading or playing. */
  isActive(): boolean;
  /** Text handed to the speaker for the current reply (used to filter out echo). */
  spokenText(): string;
  setPace(pace: VoicePace): void;
  dispose(): void;
}
