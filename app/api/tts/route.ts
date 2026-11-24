import { NextRequest } from "next/server";
import { clientIp, getIdentity } from "@/lib/auth";
import { allow } from "@/lib/rateLimit";
import { anySignal } from "@/lib/signals";
import { createEventReader } from "@/lib/sse";
import { createClient } from "@/lib/supabase/server";
import { isPace } from "@/lib/tts/profile";
import {
  buildTtsRequest,
  extractAudio,
  recordTtsUsage,
  stripWavHeader,
  ttsConfig,
  type TtsUsage,
} from "@/lib/tts/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const json = (error: string, status: number) => Response.json({ error }, { status });

const AUDIO_HEADERS = {
  "Content-Type": "application/octet-stream",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Audio-Format": "pcm16le;rate=24000;channels=1",
};

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("TTS route crashed:", e);
    return json("tts_server_error", 500);
  }
}

async function handle(req: NextRequest): Promise<Response> {
  const startedAt = performance.now();
  const cfg = ttsConfig();
  if (!cfg.enabled || !cfg.apiKey) return json("tts_not_configured", 501);

  const body = (await req.json().catch(() => null)) as { text?: unknown; pace?: unknown } | null;
  // Strip control characters, then validate length. The text is a verbatim transcript for the voice.
  const text = typeof body?.text === "string" ? body.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim() : "";
  if (!text || text.length > cfg.maxChars) return json("bad_request", 400);
  const paceInput = body?.pace;
  const pace = isPace(paceInput) ? paceInput : "normal";

  // Who is asking? Only used for fair-use limits, so any failure just means "guest".
  let userId: string | null = null;
  try {
    userId = (await getIdentity(await createClient())).userId;
  } catch {
    userId = null;
  }
  const who = userId ? "member" : "guest";
  const key = userId ?? `ip:${clientIp(req.headers)}`;

  // Cost control: a request-rate limit, a daily character budget per person, and a global budget.
  if (!allow(`tts:rate:${key}`, 60, 60_000)) return json("tts_limit", 429);
  const dailyLimit = userId ? cfg.memberDailyChars : cfg.guestDailyChars;
  if (!allow(`tts:chars:${key}`, dailyLimit, DAY_MS, text.length)) return json("tts_limit", 429);
  if (!allow("tts:global", cfg.globalDailyChars, DAY_MS, text.length)) return json("tts_limit", 429);

  const { url, body: payload, streaming } = buildTtsRequest(cfg, text, pace);
  const signal = anySignal([req.signal, AbortSignal.timeout(20_000)]);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (!req.signal.aborted) console.error("Could not reach Gemini TTS:", e);
    return json("tts_network", 502);
  }

  if (!upstream.ok || !upstream.body) {
    console.error("Gemini TTS error", upstream.status, (await upstream.text().catch(() => "")).slice(0, 300));
    if (upstream.status === 429) return json("tts_limit", 429);
    if (upstream.status === 404) return json("tts_model_not_found", 502);
    if (upstream.status === 401 || upstream.status === 403) return json("tts_auth", 502);
    if (upstream.status === 400) return json("tts_bad_request", 502);
    return json("tts_upstream", 502);
  }

  const finish = (bytes: number, usage: TtsUsage | undefined, completed: boolean) =>
    recordTtsUsage({
      who,
      model: cfg.model,
      chars: text.length,
      audioSeconds: bytes / (24000 * 2),
      usage,
      ms: performance.now() - startedAt,
      completed,
    });

  /* ───── Whole-clip path (older models, or TTS_STREAM=0) ───── */
  if (!streaming) {
    const data = await upstream.json().catch(() => null);
    const { chunks, usage } = extractAudio(data);
    if (!chunks.length) return json("tts_empty", 502);
    const audio = stripWavHeader(Buffer.concat(chunks));
    finish(audio.length, usage, true);
    return new Response(new Uint8Array(audio), { headers: AUDIO_HEADERS });
  }

  /* ───── Streaming path: forward PCM as soon as Gemini produces it ───── */
  const events = createEventReader(upstream.body);
  let usage: TtsUsage | undefined;
  let first: Buffer[] | null = null;
  for (;;) {
    const payload = await events.next();
    if (payload === null) break;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    const got = extractAudio(event);
    if (got.usage) usage = got.usage;
    if (got.error) {
      console.error("Gemini TTS stream error:", got.error);
      events.cancel();
      return json("tts_upstream", 502);
    }
    if (got.chunks.length) {
      first = got.chunks;
      break;
    }
  }
  if (!first) {
    events.cancel();
    return json("tts_empty", 502);
  }

  // Waiting for the first audio before answering lets us return a proper error status if nothing came.
  let bytes = 0;
  let logged = false;
  const logOnce = (completed: boolean) => {
    if (logged) return;
    logged = true;
    finish(bytes, usage, completed);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of first as Buffer[]) {
        bytes += c.length;
        controller.enqueue(new Uint8Array(c));
      }
    },
    async pull(controller) {
      try {
        for (;;) {
          const payload = await events.next();
          if (payload === null) {
            logOnce(true);
            controller.close();
            return;
          }
          let event: unknown;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const got = extractAudio(event);
          if (got.usage) usage = got.usage;
          if (got.chunks.length) {
            for (const c of got.chunks) {
              bytes += c.length;
              controller.enqueue(new Uint8Array(c));
            }
            return;
          }
        }
      } catch {
        logOnce(false);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      events.cancel(); // the listener interrupted or left; stop paying for audio nobody will hear
      logOnce(false);
    },
  });

  return new Response(stream, { headers: AUDIO_HEADERS });
}
