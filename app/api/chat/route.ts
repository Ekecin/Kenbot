import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_MESSAGES = 20;
const MAX_MESSAGES_GUEST = 12;
const MAX_CHARS = 4000;

// Guests can chat without an account, so they get a small allowance per network address.
// This in-memory counter is a first line of defence on a single server instance; for
// production-grade limits use a shared store (for example Upstash Redis or a Supabase table).
const GUEST_WINDOW_MS = 10 * 60 * 1000;
const GUEST_MAX_MESSAGES = 15;
const guestHits = new Map<string, { count: number; resetAt: number }>();

function allowGuest(ip: string): boolean {
  const now = Date.now();
  if (guestHits.size > 5000) {
    for (const [key, hit] of guestHits) if (hit.resetAt < now) guestHits.delete(key);
  }
  const hit = guestHits.get(ip);
  if (!hit || hit.resetAt < now) {
    guestHits.set(ip, { count: 1, resetAt: now + GUEST_WINDOW_MS });
    return true;
  }
  if (hit.count >= GUEST_MAX_MESSAGES) return false;
  hit.count += 1;
  return true;
}

const SYSTEM_PROMPT = `You are KenBot, a warm, kind and upbeat AI companion.

How you talk:
- Be friendly and genuinely encouraging. Sound like a patient friend who is happy to help, never like a manual.
- If someone seems stressed, frustrated, sad or unsure, acknowledge how they feel first, then help.
- Never talk down to anyone. No question is silly. Praise effort and curiosity sincerely, without overdoing it.
- Use simple, clear language. Explain things step by step and use small examples when it helps.
- Keep answers focused: short for simple questions, more detailed only when the topic needs it.
- Use an emoji now and then when it fits the mood, but don't overdo it.
- When it helps, end with a gentle follow-up question or an offer to go deeper, but not every time.
- Reply in the same language the person writes in.

Honesty comes with the kindness:
- Never make things up to be nice. If you are not sure, say so in a friendly way.
- If you have to disagree or correct something, do it gently and explain why.
- If someone seems to be in real distress or danger, respond with care, encourage them to reach out to someone they trust or to local emergency services, and stay supportive.
- If you can't help with a request, say so kindly and offer something you can do instead.`;

const VOICE_PROMPT = `

This is a live voice conversation, and your reply will be read aloud.
- Answer in one to three short, natural, spoken sentences unless the person clearly asks for detail.
- Do not use markdown, bullet points, numbered lists, code blocks, links or emoji.
- Talk like a warm friend on a phone call. If you need to give steps, give one at a time and ask if they want the next.
- The words come from speech recognition, so quietly make sense of small mistakes.`;

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

  // The conversation must start and end with the user.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

function json(error: string, status: number) {
  return Response.json({ error }, { status });
}

function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || "New chat";
}

async function handle(req: NextRequest): Promise<Response> {
  // 1. Only signed-in people can chat. This also protects your Gemini quota.
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (e) {
    console.error(e);
    return json("missing_supabase", 500);
  }
  // Signed-in people get saved history. Guests can still chat, but nothing is saved.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  const isGuest = userId === null;

  if (isGuest) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allowGuest(ip)) return json("guest_limit", 429);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json("missing_key", 500);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json("bad_request", 400);
  }

  const turns = readTurns(body, isGuest ? MAX_MESSAGES_GUEST : MAX_MESSAGES);
  if (!turns) return json("bad_request", 400);
  const lastUserText = turns[turns.length - 1].text;
  const voice = (body as { voice?: unknown }).voice === true;

  // 2. Personalise: use the person's name.
  let name = "";
  if (userId && user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();
    name = String(profile?.display_name ?? user.user_metadata?.display_name ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 40);
  }

  let system = SYSTEM_PROMPT;
  if (name) {
    system += `\n\nThe person you're talking with is called ${name}. Use their name now and then, naturally, but not in every reply.`;
  }
  if (voice) system += VOICE_PROMPT;

  // 3. Find or create this conversation, and save the person's message.
  //    If saving fails (for example the tables aren't created yet) the chat still works.
  let conversationId: string | null = null;
  const requested = (body as { conversationId?: unknown }).conversationId;
  if (userId && typeof requested === "string" && /^[0-9a-f-]{36}$/i.test(requested)) {
    const { data } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", requested)
      .maybeSingle();
    if (data) conversationId = data.id;
  }
  if (userId && !conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: userId, title: makeTitle(lastUserText) })
      .select("id")
      .single();
    if (error) console.error("Could not create conversation:", error.message);
    else conversationId = data.id;
  }
  if (userId && conversationId) {
    const { error } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "user",
      content: lastUserText,
    });
    if (error) console.error("Could not save message:", error.message);
  }
  const convId = conversationId;

  // 4. Ask Gemini.
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:streamGenerateContent?alt=sse`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: {
          temperature: 0.8,
          // Keep spoken replies concise, but allow normal chat answers to be detailed.
          // Gemini 3.8 Flash supports up to 65,536 output tokens.
          maxOutputTokens: voice ? 512 : 16384,
        },
      }),
      // Stops the upstream request if the visitor hits "Stop" or leaves.
      signal: req.signal,
    });
  } catch (e) {
    console.error("Could not reach Gemini:", e);
    return json("network", 502);
  }

  if (!upstream.ok || !upstream.body) {
    console.error("Gemini error", upstream.status, await upstream.text().catch(() => ""));
    if (upstream.status === 429) return json("rate_limited", 429);
    if (upstream.status === 404) return json("model_not_found", 502);
    if (upstream.status === 500 || upstream.status === 503) return json("overloaded", 502);
    if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) {
      return json("auth", 502);
    }
    return json("upstream", 502);
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let emitted = false;
      let full = "";
      let streamClosed = false;

      // Gemini sends Server-Sent Events. Parse complete events rather than
      // assuming that a network chunk always contains a complete JSON line.
      const pushEvent = (event: string) => {
        const dataLines = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (!dataLines.length) return;
        const payload = dataLines.join("\n");
        if (!payload || payload === "[DONE]") return;

        try {
          const data = JSON.parse(payload);
          if (data?.error) {
            console.error("Gemini stream error:", data.error);
            return;
          }

          const candidate = data?.candidates?.[0];
          const parts = candidate?.content?.parts;
          if (Array.isArray(parts)) {
            const text = parts
              .map((part: { text?: string }) => part?.text ?? "")
              .join("");
            if (text) {
              full += text;
              controller.enqueue(encoder.encode(text));
              emitted = true;
            }
          }

          if (candidate?.finishReason) {
            console.info("Gemini finish reason:", candidate.finishReason);
          }
        } catch (error) {
          console.error("Could not parse Gemini stream event:", error);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) pushEvent(event);
        }

        // Flush any bytes held by TextDecoder and process the final event,
        // which may not be followed by the usual blank-line separator.
        buffer += decoder.decode();
        if (buffer.trim()) pushEvent(buffer);

        if (!emitted) {
          full = FALLBACK;
          controller.enqueue(encoder.encode(FALLBACK));
        }
      } catch (error) {
        console.error("Gemini response stream interrupted:", error);
      } finally {
        // Persist the response received so far before closing the stream.
        if (userId && convId && full.trim()) {
          try {
            const [saved, touched] = await Promise.all([
              supabase.from("messages").insert({
                conversation_id: convId,
                user_id: userId,
                role: "bot",
                content: full,
              }),
              supabase
                .from("conversations")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", convId),
            ]);
            if (saved.error) console.error("Could not save reply:", saved.error.message);
            if (touched.error) console.error("Could not update chat:", touched.error.message);
          } catch (error) {
            console.error("Saving the reply failed:", error);
          }
        }

        if (!streamClosed) {
          streamClosed = true;
          try {
            controller.close();
          } catch {
            // The client may already have cancelled the stream.
          }
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  };
  if (convId) headers["X-Conversation-Id"] = convId;
  if (isGuest) headers["X-Guest"] = "1";

  return new Response(stream, { headers });
}

// Any unexpected crash becomes a clear JSON error (and a log line) instead of a blank 500.
export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("Chat route crashed:", e);
    return json("server_error", 500);
  }
}
