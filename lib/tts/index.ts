// Speech-engine factory. KenBot's conversation logic only ever talks to the SpeechEngine
// interface, so providers can be swapped here without touching the chat screen.
import { createBrowserEngine } from "./browser";
import { createGeminiEngine, neuralVoiceSupported } from "./google";
import type { SpeechEngine, SpeechEvents, TtsProviderId, VoicePace } from "./types";

export { prepareForSpeech as cleanForSpeech } from "./speechText";
export { isPace } from "./profile";
export type { SpeechEngine, SpeechEvents, SpeechMetric, TtsProviderId, VoicePace } from "./types";

export function voiceOutputAvailable(provider: TtsProviderId): boolean {
  return (provider === "gemini" && neuralVoiceSupported()) || (typeof window !== "undefined" && "speechSynthesis" in window);
}

/**
 * Create the engine for `provider`. "gemini" uses the neural voice with the built-in browser voice
 * as an automatic fallback; "browser" uses only the built-in voice. Returns null if neither works.
 */
export function createSpeechEngine(opts: {
  provider: TtsProviderId;
  pace?: VoicePace;
  events?: SpeechEvents;
}): SpeechEngine | null {
  const browser = createBrowserEngine(opts.events, opts.pace);
  if (opts.provider === "gemini" && neuralVoiceSupported()) {
    return createGeminiEngine({ events: opts.events, pace: opts.pace, browser });
  }
  return browser;
}
