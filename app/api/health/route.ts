import { NextRequest } from "next/server";
import { GEMINI_API_BASE, geminiModel, maxTokens, thinkingLevel } from "@/lib/gemini";
import { createEventReader } from "@/lib/sse";
import { buildTtsRequest, extractAudio, ttsConfig } from "@/lib/tts/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A quick self-check for setup problems.
//   /api/health               shows which settings are present (never their values)
//   /api/health?probe=all     really calls Gemini, web search, the neural voice and Supabase and times each
// In production, probes need HEALTH_TOKEN: add &token=YOUR_TOKEN (or an x-health-token header).

type Probe = { ok: boolean; ms: number; status?: number; note?: string };

const TIMEOUT_MS = 20_000;

async function timed(run: () => Promise<Omit<Probe, "ms">>): Promise<Probe> {
  const t = performance.now();
  try {
    const result = await run();
    return { ...result, ms: Math.round(performance.now() - t) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, ms: Math.round(performance.now() - t), note: `Could not connect: ${message}`.slice(0, 200) };
  }
}

function describeError(text: string, status: number): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    if (message) return `${status}: ${message}`.slice(0, 240);
  } catch {
    // not JSON
  }
  return `${status}: ${text.slice(0, 160)}`;
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = geminiModel();
  const tts = ttsConfig();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const report: Record<string, unknown> = {
    time: new Date().toISOString(),
    node: process.version,
    settings: {
      geminiKeyPresent: !!apiKey,
      model,
      thinkingVoice: thinkingLevel(model, true) ?? "model default",
      thinkingText: thinkingLevel(model, false) ?? "model default",
      webSearch: (process.env.WEB_SEARCH ?? "on").toLowerCase() !== "off",
      neuralVoice: tts.enabled,
      ttsModel: tts.model,
      ttsVoice: tts.voice,
      supabaseUrlPresent: !!supabaseUrl,
      supabaseKeyPresent: !!supabaseKey,
    },
  };

  const wanted = req.nextUrl.searchParams.get("probe");
  if (!wanted) return Response.json(report);

  const token = process.env.HEALTH_TOKEN;
  const allowed =
    process.env.NODE_ENV !== "production" ||
    (!!token && (req.nextUrl.searchParams.get("token") === token || req.headers.get("x-health-token") === token));
  if (!allowed) {
    return Response.json(
      { ...report, error: "probe_disabled", hint: "Set HEALTH_TOKEN in your environment variables, then add &token=YOUR_TOKEN." },
      { status: 403 },
    );
  }

  const all = wanted === "all";
  const probes: Record<string, Probe> = {};
  const headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey ?? "" };
  const redact = (text: string) => (apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[key]") : text);

  if (apiKey && (all || wanted === "gemini")) {
    probes.gemini = await timed(async () => {
      const level = thinkingLevel(model, true);
      const res = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
          generationConfig: { maxOutputTokens: maxTokens(true), ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}) },
        }),
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, note: res.ok ? "Gemini answered" : redact(describeError(text, res.status)) };
    });
  }

  if (apiKey && (all || wanted === "search")) {
    probes.webSearch = await timed(async () => {
      const res = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "What is today's date? Answer in one short sentence." }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 200 },
        }),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, note: redact(describeError(text, res.status)) + " (web search needs a paid Gemini API plan)" };
      const grounded = !!(JSON.parse(text) as { candidates?: { groundingMetadata?: unknown }[] }).candidates?.[0]?.groundingMetadata;
      return { ok: true, status: res.status, note: grounded ? "Search ran and returned sources" : "Accepted, but the model chose not to search for this question" };
    });
  }

  if (apiKey && tts.enabled && (all || wanted === "tts")) {
    probes.neuralVoice = await timed(async () => {
      const { url, body, streaming } = buildTtsRequest(tts, "Hello, this is KenBot.", "normal");
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok || !res.body) return { ok: false, status: res.status, note: redact(describeError(await res.text(), res.status)) };
      if (!streaming) {
        const { chunks } = extractAudio(await res.json());
        return { ok: chunks.length > 0, status: res.status, note: chunks.length ? "Audio produced" : "No audio returned" };
      }
      const reader = createEventReader(res.body);
      for (;;) {
        const payload = await reader.next();
        if (payload === null) return { ok: false, status: res.status, note: "Stream ended without audio" };
        try {
          if (extractAudio(JSON.parse(payload)).chunks.length) {
            reader.cancel();
            return { ok: true, status: res.status, note: "First audio arrived (ms shown is time to first audio)" };
          }
        } catch {
          // keep reading
        }
      }
    });
  }

  if (supabaseUrl && supabaseKey && (all || wanted === "supabase")) {
    probes.supabase = await timed(async () => {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/health`, {
        headers: { apikey: supabaseKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { ok: res.ok, status: res.status, note: res.ok ? "Supabase is reachable" : `Unexpected status ${res.status}` };
    });
  }

  const failed = Object.entries(probes).filter(([, p]) => !p.ok).map(([name]) => name);
  return Response.json({ ...report, probes, overall: failed.length ? "problems" : "ok", failed });
}
