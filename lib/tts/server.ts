// Server-side helpers for the /api/tts route: configuration, the Gemini TTS request, audio
// extraction, cost estimates and usage tracking. Never import this from browser code.
import { geminiStyleFor } from "./profile";
import type { VoicePace } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export type TtsConfig = {
  enabled: boolean;
  apiKey: string | undefined;
  model: string;
  voice: string;
  style: string | undefined;
  maxChars: number;
  memberDailyChars: number;
  guestDailyChars: number;
  globalDailyChars: number;
  stream: boolean;
};

export function ttsConfig(): TtsConfig {
  const provider = (process.env.TTS_PROVIDER ?? "gemini").toLowerCase();
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts";
  return {
    enabled: provider !== "browser" && !!apiKey,
    apiKey,
    model,
    voice: process.env.GEMINI_TTS_VOICE || "Sulafat", // "Warm". Try Achird (friendly) or Vindemiatrix (gentle).
    style: process.env.GEMINI_TTS_STYLE || undefined,
    maxChars: intEnv("TTS_MAX_CHARS", 500),
    memberDailyChars: intEnv("TTS_DAILY_CHARS_MEMBER", 30000),
    guestDailyChars: intEnv("TTS_DAILY_CHARS_GUEST", 3000),
    globalDailyChars: intEnv("TTS_DAILY_CHARS_GLOBAL", 600000),
    stream: process.env.TTS_STREAM ? process.env.TTS_STREAM !== "0" : model.includes("3.8"),
  };
}

/** The Gemini 3.8 TTS models use a new request shape; older preview models need the legacy one. */
export function buildTtsRequest(cfg: TtsConfig, text: string, pace: VoicePace) {
  const style = geminiStyleFor(pace, cfg.style);
  if (cfg.model.includes("3.8")) {
    const method = cfg.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return {
      url: `${API_BASE}/models/${encodeURIComponent(cfg.model)}:${method}`,
      streaming: cfg.stream,
      body: {
        contents: [{ role: "user", parts: [{ text, speech_metadata: { style } }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { voice: cfg.voice } },
        },
      },
    };
  }
  return {
    url: `${API_BASE}/models/${encodeURIComponent(cfg.model)}:generateContent`,
    streaming: false,
    body: {
      contents: [{ parts: [{ text: `Say in a ${style} voice: ${text}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
      },
    },
  };
}

export type TtsUsage = { promptTokenCount?: number; candidatesTokenCount?: number };

/** Pull raw audio bytes (and usage numbers) out of one Gemini response event. */
export function extractAudio(event: unknown): { chunks: Buffer[]; usage?: TtsUsage; error?: string } {
  const e = event as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string }; inline_data?: { data?: string } }[] } }[];
    usageMetadata?: TtsUsage;
    error?: { message?: string };
  };
  const chunks: Buffer[] = [];
  for (const part of e?.candidates?.[0]?.content?.parts ?? []) {
    const data = part?.inlineData?.data ?? part?.inline_data?.data;
    if (typeof data === "string" && data) chunks.push(Buffer.from(data, "base64"));
  }
  return { chunks, usage: e?.usageMetadata, error: e?.error?.message };
}

/** Non-streaming responses from 3.8 models are WAV files; the browser expects headerless PCM. */
export function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF") {
    const at = buf.indexOf("data", 12, "ascii");
    if (at !== -1 && at < 200) return buf.subarray(at + 8);
  }
  return buf;
}

/**
 * Rough cost in US dollars. Defaults follow Google's published prices for the Gemini 3.8 TTS
 * models (per million tokens, audio at 25 tokens per second), including the increase scheduled
 * for 1 January 2027. Set TTS_PRICE_IN_PER_M and TTS_PRICE_OUT_PER_M to override. The real bill
 * comes from Google; this is for monitoring.
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, at: Date = new Date()): number {
  const envIn = Number(process.env.TTS_PRICE_IN_PER_M);
  const envOut = Number(process.env.TTS_PRICE_OUT_PER_M);
  let priceIn: number;
  let priceOut: number;
  if (envIn > 0 && envOut > 0) {
    priceIn = envIn;
    priceOut = envOut;
  } else {
    const after = at.getTime() >= Date.UTC(2027, 0, 1);
    if (/3\.8-flash-lite-tts/.test(model)) [priceIn, priceOut] = after ? [1, 12] : [0.5, 6];
    else if (/3\.8-flash-tts/.test(model)) [priceIn, priceOut] = after ? [1, 18] : [0.5, 9];
    else [priceIn, priceOut] = [1, 20]; // older preview models: assume the higher price
  }
  return (inputTokens * priceIn + outputTokens * priceOut) / 1_000_000;
}

const totals = { requests: 0, chars: 0, audioSeconds: 0, estUsd: 0, since: new Date().toISOString() };

/** Log one synthesis (counts only, never the text) and keep running totals for this server instance. */
export function recordTtsUsage(e: {
  who: "member" | "guest";
  model: string;
  chars: number;
  audioSeconds: number;
  usage?: TtsUsage;
  ms: number;
  completed: boolean;
}): void {
  const outputTokens = e.usage?.candidatesTokenCount ?? Math.round(e.audioSeconds * 25);
  const inputTokens = e.usage?.promptTokenCount ?? Math.ceil(e.chars / 4);
  const estUsd = estimateCostUsd(e.model, inputTokens, outputTokens);
  totals.requests += 1;
  totals.chars += e.chars;
  totals.audioSeconds += e.audioSeconds;
  totals.estUsd += estUsd;
  console.log(
    JSON.stringify({
      evt: "tts",
      who: e.who,
      model: e.model,
      chars: e.chars,
      audioSec: Number(e.audioSeconds.toFixed(2)),
      inTok: inputTokens,
      outTok: outputTokens,
      estUsd: Number(estUsd.toFixed(6)),
      ms: Math.round(e.ms),
      completed: e.completed,
    }),
  );
  if (totals.requests % 25 === 0) {
    console.log(JSON.stringify({ evt: "tts_totals", ...totals, audioSeconds: Math.round(totals.audioSeconds), estUsd: Number(totals.estUsd.toFixed(4)) }));
  }
}
