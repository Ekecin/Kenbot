import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { clientIp, getIdentity } from "@/lib/auth";
import { buildTrailer, extractGrounding } from "@/lib/grounding";
import { allow } from "@/lib/rateLimit";
import { anySignal } from "@/lib/signals";
import { createEventReader } from "@/lib/sse";
import { GEMINI_API_BASE, geminiModel, intEnv, maxTokens, thinkingLevel } from "@/lib/gemini";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Supabase = Awaited<ReturnType<typeof createClient>>;

const MAX_MESSAGES = 20;
const MAX_MESSAGES_GUEST = 12;
const MAX_CHARS = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guests can chat without an account, so they get a small allowance per network address.
// These in-memory counters are a first line of defence; for hard limits use a shared store.
const GUEST_WINDOW_MS = 10 * 60 * 1000;
const GUEST_MAX_MESSAGES = 15;

const SYSTEM_PROMPT = `You are KenBot, a warm, kind and honest AI companion.

- Sound like a patient friend, never like a manual. If someone seems stressed or unsure, acknowledge how they feel first, then help. Never talk down to anyone.
- Be clear and direct. Keep answers as short as the question allows and go deeper when asked. Use small examples and step by step explanations when they help.
- Honesty comes first: if you are unsure, say so gently; correct mistakes kindly; never invent facts.
- If someone seems to be in real distress or danger, respond with care and encourage them to reach someone they trust or local emergency services.
- Reply in the language the person writes in. In text chats an occasional emoji is fine.
- Keep track of the conversation: build on what was said earlier, treat corrections as updates, don't repeat greetings or information you already gave, and ask one short clarifying question only when the request is truly ambiguous.`;

const SEARCH_PROMPT = `

You can search the web. Use it for anything that depends on recent or changing information: news, sports results, prices, weather, product releases, "latest", "today", "right now", or facts you are not sure are still current. Don't search for timeless knowledge, maths, writing help or casual chat. After searching, answer in your own words, say plainly what you found and how recent it is, and mention it if sources disagree. Never paste web addresses into the reply; sources are shown separately.`;

const VOICE_PROMPT = `

This is a live spoken conversation, and your words will be read aloud.
- Talk like a relaxed, intelligent friend: usually one to three short sentences. If the person asks for detail, give it a few spoken-style sentences at a time and offer to continue.
- Use plain spoken language only: no markdown, lists, headings, links, code, emoji or stage directions. Write numbers, dates and money the way you would say them.
- Don't open with filler such as "Sure!" or "Great question!", don't repeat the question back, and don't greet again mid-conversation.
- The words come from speech recognition, so quietly make sense of small mistakes. If something is unclear, ask one short question.
- If the person interrupts or corrects you, simply adapt; no long apologies.`;

const FALLBACK =
  "I can't help with that one, but I'd be glad to help with something else. What would you like to try instead?";

type Turn = { role: "user" | "model"; text: string };

function readTurns(input: unknown, maxMessages: number): Turn[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return null;

  const turns: Turn[] = [];
  for (const item of raw.slice(-maxMessages)) {
    if (!item || typeof item !== "object") continue;
    const { role, text } = item as { role?: unknown; text?: unknown };
    if ((role !== "user" && role !== "model") || typeof text !== "string") continue;
    const trimmed = text.trim().slice(0, MAX_CHARS);
    if (!trimmed) continue;

    // Merge back-to-back turns from the same role so the history always alternates.
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += `\n\n${trimmed}`;
    else turns.push({ role, text: trimmed });
  }

  // The conversation must start and end with the person.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

const json = (error: string, status: number) => Response.json({ error }, { status });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || "New chat";
}

/** "Today is …" in the person's own time zone, so questions like "what day is it" are right. */
function todayLine(timeZone: unknown): string {
  const zone =
    typeof timeZone === "string" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(timeZone) ? timeZone : "UTC";
  try {
    const stamp = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: zone }).format(new Date());
    return `\n\nRight now it is ${stamp} (${zone}).`;
  } catch {
    return `\n\nRight now it is ${new Date().toUTCString()}.`;
  }
}

/* ───────── Web search availability ───────── */

// Google Search grounding needs a paid Gemini API plan. If the API refuses it, stop asking for a while.
const SEARCH_RETRY_AFTER_MS = 30 * 60 * 1000;
let searchRejectedUntil = 0;
const thinkingRejected = new Set<string>();

function searchWanted(userId: string | null, ip: string): boolean {
  if ((process.env.WEB_SEARCH ?? "on").toLowerCase() === "off") return false;
  if (Date.now() < searchRejectedUntil) return false;
  // Budgets protect your bill: Google charges for each search the model runs.
  const own = userId
    ? allow(`search:m:${userId}`, intEnv("SEARCH_DAILY_MEMBER", 100), DAY_MS)
    : allow(`search:g:${ip}`, intEnv("SEARCH_DAILY_GUEST", 10), DAY_MS);
  return own && allow("search:global", intEnv("SEARCH_DAILY_GLOBAL", 1000), DAY_MS);
}

/**
 * Ask Gemini. Optional extras (thinking level, web search) are dropped automatically if the API
 * says the model or plan can't use them, and a temporary server error is retried once.
 */
async function requestGemini(args: {
  url: string;
  apiKey: string;
  system: string;
  contents: unknown[];
  voice: boolean;
  model: string;
  useSearch: boolean;
  signal: AbortSignal;
}): Promise<{ res: Response; searchUsed: boolean }> {
  const level = thinkingLevel(args.model, args.voice);
  let thinking = !!level && !thinkingRejected.has(`${args.model}:${level}`);
  let search = args.useSearch;
  let retriedServerError = false;

  const build = () =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: args.contents,
      ...(search ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        maxOutputTokens: maxTokens(args.voice),
        ...(thinking && level ? { thinkingConfig: { thinkingLevel: level } } : {}),
      },
    });

  for (let attempt = 0; attempt < 5; attempt++) {
    let res: Response;
    try {
      res = await fetch(args.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": args.apiKey },
        body: build(),
        signal: args.signal,
      });
    } catch (e) {
      if (args.signal.aborted || retriedServerError) throw e;
      retriedServerError = true;
      await sleep(250);
      continue;
    }

    if (res.status === 400 || res.status === 403) {
      const text = await res.text().catch(() => "");
      const lower = text.toLowerCase();
      const aboutThinking = lower.includes("thinking");
      const aboutSearch = /search|ground|tool/.test(lower);
      if (thinking && (aboutThinking || (!aboutSearch && !search))) {
        thinking = false;
        if (level) thinkingRejected.add(`${args.model}:${level}`);
        continue;
      }
      if (search && (aboutSearch || res.status === 400)) {
        search = false;
        searchRejectedUntil = Date.now() + SEARCH_RETRY_AFTER_MS;
        console.warn("Web search was refused by the API; continuing without it for a while.", text.slice(0, 200));
        continue;
      }
      if (thinking && res.status === 400) {
        thinking = false;
        if (level) thinkingRejected.add(`${args.model}:${level}`);
        continue;
      }
      return { res: new Response(text, { status: res.status }), searchUsed: false };
    }

    if ((res.status === 500 || res.status === 503) && !retriedServerError) {
      retriedServerError = true;
      await res.body?.cancel().catch(() => {});
      await sleep(250);
      continue;
    }
    return { res, searchUsed: search };
  }
  throw new Error("Gemini request failed");
}

/** Save the person's message. Runs at the same time as the model call, so it never delays the reply. */
async function persistUserTurn(supabase: Supabase, userId: string, convId: string, text: string): Promise<void> {
  try {
    const created = await supabase
      .from("conversations")
      .upsert({ id: convId, user_id: userId, title: makeTitle(text) }, { onConflict: "id", ignoreDuplicates: true });
    if (created.error) console.error("Could not create conversation:", created.error.message);
    const saved = await supabase
      .from("messages")
      .insert({ conversation_id: convId, user_id: userId, role: "user", content: text });
    if (saved.error) console.error("Could not save message:", saved.error.message);
  } catch (e) {
    console.error("Saving the message failed:", e);
  }
}

async function persistReply(supabase: Supabase, userId: string, convId: string, text: string): Promise<void> {
  try {
    const [saved, touched] = await Promise.all([
      supabase.from("messages").insert({ conversation_id: convId, user_id: userId, role: "bot", content: text }),
      supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId),
    ]);
    if (saved.error) console.error("Could not save reply:", saved.error.message);
    if (touched.error) console.error("Could not update chat:", touched.error.message);
  } catch (e) {
    console.error("Saving the reply failed:", e);
  }
}

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("Chat route crashed:", e);
    return json("server_error", 500);
  }
}

async function handle(req: NextRequest): Promise<Response> {
  const t0 = performance.now();

  let supabase: Supabase;
  try {
    supabase = await createClient();
  } catch (e) {
    console.error(e);
    return json("missing_supabase", 500);
  }

  // Read the body and work out who is asking at the same time.
  const [body, identity] = await Promise.all([req.json().catch(() => null), getIdentity(supabase)]);
  const { userId } = identity;
  const isGuest = userId === null;
  const ip = clientIp(req.headers);

  if (isGuest && !allow(`chat:guest:${ip}`, GUEST_MAX_MESSAGES, GUEST_WINDOW_MS)) {
    return json("guest_limit", 429);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json("missing_key", 500);

  const turns = readTurns(body, isGuest ? MAX_MESSAGES_GUEST : MAX_MESSAGES);
  if (!turns) return json("bad_request", 400);
  const lastUserText = turns[turns.length - 1].text;
  const voice = (body as { voice?: unknown }).voice === true;
  const useSearch = searchWanted(userId, ip);

  // Personalise from the sign-in token (no database query) and tell the model when "now" is.
  let system = SYSTEM_PROMPT;
  if (identity.name) {
    system += `\n\nThe person you're talking with is called ${identity.name}. Use their name now and then, naturally, but not in every reply.`;
  }
  if (useSearch) system += SEARCH_PROMPT;
  if (voice) system += VOICE_PROMPT;
  system += todayLine((body as { tz?: unknown }).tz);

  // Members: save the message in the background while the model starts working.
  let convId: string | null = null;
  let persisted: Promise<void> = Promise.resolve();
  if (userId) {
    const requested = (body as { conversationId?: unknown }).conversationId;
    convId = typeof requested === "string" && UUID.test(requested) ? requested : randomUUID();
    persisted = persistUserTurn(supabase, userId, convId, lastUserText);
  }

  const model = geminiModel();
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  // Fail fast instead of hanging: if Gemini hasn't started answering in time, say so clearly.
  const headerTimeoutMs = intEnv("GEMINI_HEADER_TIMEOUT_MS", 25_000);
  const headerTimer = new AbortController();
  const headerTimeout = setTimeout(() => headerTimer.abort(), headerTimeoutMs);
  const signal = anySignal([req.signal, headerTimer.signal, AbortSignal.timeout(90_000)]);
  const prepMs = performance.now() - t0;

  let upstream: Response;
  let searchUsed = false;
  try {
    const result = await requestGemini({
      url,
      apiKey,
      system,
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      voice,
      model,
      useSearch,
      signal,
    });
    upstream = result.res;
    searchUsed = result.searchUsed;
  } catch (e) {
    clearTimeout(headerTimeout);
    await persisted;
    if (headerTimer.signal.aborted && !req.signal.aborted) {
      console.error(`Gemini did not respond within ${headerTimeoutMs} ms`);
      return json("timeout", 504);
    }
    if (!req.signal.aborted) console.error("Could not reach Gemini:", e);
    return json("network", 502);
  }
  clearTimeout(headerTimeout);
  const headersMs = performance.now() - t0;

  if (!upstream.ok || !upstream.body) {
    console.error("Gemini error", upstream.status, (await upstream.text().catch(() => "")).slice(0, 300));
    await persisted;
    if (upstream.status === 429) return json("rate_limited", 429);
    if (upstream.status === 404) return json("model_not_found", 502);
    if (upstream.status === 500 || upstream.status === 503) return json("overloaded", 502);
    if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) return json("auth", 502);
    return json("upstream", 502);
  }

  if (process.env.NODE_ENV !== "production" || process.env.VOICE_DEBUG === "1") {
    console.log(
      `[chat] voice=${voice} search=${searchUsed} prep=${prepMs.toFixed(0)}ms gemini-headers=${headersMs.toFixed(0)}ms model=${model}`,
    );
  }

  const events = createEventReader(upstream.body);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      let emitted = false;
      let finishReason = "";
      let grounding: unknown = null;
      let trailer = "";
      try {
        for (;;) {
          const payload = await events.next();
          if (payload === null) break;
          let data: {
            candidates?: {
              finishReason?: string;
              groundingMetadata?: unknown;
              content?: { parts?: { text?: string; thought?: boolean }[] };
            }[];
          };
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          const candidate = data.candidates?.[0];
          const text = (candidate?.content?.parts ?? [])
            .filter((p) => !p.thought)
            .map((p) => p.text ?? "")
            .join("");
          if (text) {
            full += text;
            emitted = true;
            controller.enqueue(encoder.encode(text));
          }
          if (candidate?.groundingMetadata) grounding = candidate.groundingMetadata;
          if (candidate?.finishReason) finishReason = candidate.finishReason;
        }
        if (!emitted) {
          full = FALLBACK;
          controller.enqueue(encoder.encode(FALLBACK));
        }
        // Web sources and Google's required "Search Suggestions" arrive last, after the text.
        const meta = emitted ? extractGrounding(grounding) : null;
        if (meta) {
          trailer = buildTrailer(meta);
          controller.enqueue(encoder.encode(trailer));
          const queries = (grounding as { webSearchQueries?: unknown[] } | null)?.webSearchQueries;
          console.log(JSON.stringify({ evt: "search", queries: Array.isArray(queries) ? queries.length : 0, sources: meta.sources.length }));
        }
      } catch {
        // The person stopped the reply or the connection dropped.
      } finally {
        if (finishReason === "MAX_TOKENS") console.warn(`Reply reached the output limit (voice=${voice}); consider raising GEMINI_MAX_TOKENS_*.`);
        // Save the reply (even a partial one) before closing, so serverless hosts don't cut the save short.
        await persisted;
        if (userId && convId && full.trim()) await persistReply(supabase, userId, convId, full + trailer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      events.cancel();
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
    "X-Search": searchUsed ? "on" : "off",
    "Server-Timing": `prep;dur=${prepMs.toFixed(0)}, gemini;dur=${headersMs.toFixed(0)}`,
  };
  if (convId) headers["X-Conversation-Id"] = convId;
  if (isGuest) headers["X-Guest"] = "1";

  return new Response(stream, { headers });
}
