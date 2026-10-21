import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;

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

const FALLBACK =
  "I can't help with that one, but I'd be glad to help with something else. What would you like to try instead?";

type Turn = { role: "user" | "model"; text: string };

function readTurns(input: unknown): Turn[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return null;

  const turns: Turn[] = [];
  for (const item of raw.slice(-MAX_MESSAGES)) {
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

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json("missing_key", 500);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json("bad_request", 400);
  }

  const turns = readTurns(body);
  if (!turns) return json("bad_request", 400);

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
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
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
      }),
      // Stops the upstream request if the visitor hits "Stop" or leaves.
      signal: req.signal,
    });
  } catch {
    return json("network", 502);
  }

  if (!upstream.ok || !upstream.body) {
    console.error("Gemini error", upstream.status, await upstream.text().catch(() => ""));
    if (upstream.status === 429) return json("rate_limited", 429);
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

      // Gemini streams Server-Sent Events; pull the text out of each one.
      const push = (line: string): boolean => {
        if (!line.startsWith("data:")) return false;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return false;
        try {
          const data = JSON.parse(payload);
          const parts = data?.candidates?.[0]?.content?.parts;
          if (!Array.isArray(parts)) return false;
          const text = parts.map((p: { text?: string }) => p.text ?? "").join("");
          if (!text) return false;
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          return false;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) emitted = push(line) || emitted;
        }
        if (buffer) emitted = push(buffer) || emitted;
        if (!emitted) controller.enqueue(encoder.encode(FALLBACK));
      } catch {
        // The visitor stopped the reply or the connection dropped.
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
