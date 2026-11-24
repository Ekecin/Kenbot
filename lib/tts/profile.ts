// KenBot's voice personality, defined once and mapped onto each speech provider.
import type { VoicePace } from "./types";

/**
 * The full brief for how KenBot should sound. Engines that accept free-text direction can use
 * it as-is; the Gemini 3.8 TTS models work better with a SHORT constant style (see below).
 */
export const VOICE_PERSONALITY =
  "Speak naturally, as though having a relaxed conversation with someone. Maintain a warm, intelligent and approachable personality. Use natural variations in pitch, rhythm and speaking speed. Emphasize important words appropriately. Pause naturally between thoughts. Adapt vocal expression to the emotional context of the conversation. Avoid sounding like someone reading a written document or presenting a news broadcast. Speak clearly, comfortably and naturally.";

/**
 * Google's guidance for Gemini 3.8 TTS is to keep the per-turn style short and constant, and to
 * let the chosen voice carry the identity. Long persona blocks are the most common cause of
 * voice drift between turns. This is the condensed form of VOICE_PERSONALITY.
 */
export const GEMINI_BASE_STYLE =
  "warm, calm and friendly, like a relaxed conversation with a thoughtful friend";

const PACE_SUFFIX: Record<VoicePace, string> = {
  slow: ", at a relaxed, slightly slower pace",
  normal: "",
  fast: ", at a brisk but clear pace",
};

export function geminiStyleFor(pace: VoicePace, override?: string): string {
  return (override?.trim() || GEMINI_BASE_STYLE) + PACE_SUFFIX[pace];
}

export const BROWSER_VOICE = {
  rate: { slow: 0.92, normal: 1.0, fast: 1.15 } as Record<VoicePace, number>,
  pitch: 1.03,
};

export function isPace(value: unknown): value is VoicePace {
  return value === "slow" || value === "normal" || value === "fast";
}
