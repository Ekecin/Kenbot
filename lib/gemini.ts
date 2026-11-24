// Settings shared by the chat route and the health check. Server-side only.

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

export const geminiModel = () => process.env.GEMINI_MODEL || "gemini-3.6-flash";

/**
 * How much "thinking" the model does before answering. Less thinking means a faster first word,
 * which matters most in voice. Gemini 3.5/3.6 Flash accept "minimal"; 3.7/3.8 Flash don't, so they
 * use "low". Override with GEMINI_THINKING_VOICE / GEMINI_THINKING_TEXT (use "default" to leave
 * the model's own default). Unknown models are left alone.
 */
export function thinkingLevel(model: string, voice: boolean): string | null {
  const override = voice ? process.env.GEMINI_THINKING_VOICE : process.env.GEMINI_THINKING_TEXT;
  if (override) return override === "default" ? null : override;
  if (/gemini-3\.[56]-flash(?!-lite)/.test(model)) return voice ? "minimal" : "low";
  if (/gemini-3\.[78]-flash(?!-lite)/.test(model)) return "low";
  return null;
}

export function maxTokens(voice: boolean): number {
  const v = Number(voice ? process.env.GEMINI_MAX_TOKENS_VOICE : process.env.GEMINI_MAX_TOKENS_TEXT);
  if (Number.isFinite(v) && v > 0) return Math.floor(v);
  // Thinking tokens count toward the limit, so keep generous headroom to avoid cut-off replies.
  return voice ? 600 : 2048;
}
