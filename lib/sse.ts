// Reads a streamed Gemini response body and yields one JSON string per event.
// It understands both Server-Sent Events ("data: {...}") and the plain streamed JSON array
// that the API uses when `alt=sse` is not honoured, so a change on Google's side can't break it.

export function createEventReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queue: string[] = [];
  let ended = false;
  let mode: "unknown" | "sse" | "json" = "unknown";

  // SSE state
  let lineBuffer = "";
  // JSON state
  let depth = 0;
  let inString = false;
  let escaped = false;
  let object = "";

  const pushSseLines = (lines: string[]) => {
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") queue.push(payload);
    }
  };

  const feedJson = (text: string) => {
    for (const ch of text) {
      if (depth === 0) {
        if (ch === "{") {
          depth = 1;
          object = "{";
          inString = false;
          escaped = false;
        }
        continue;
      }
      object += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        queue.push(object);
        object = "";
      }
    }
  };

  const feed = (text: string) => {
    if (mode === "unknown") {
      const t = text.trimStart();
      if (!t) return;
      mode = t.startsWith("data:") || t.startsWith("event:") || t.startsWith(":") ? "sse" : "json";
    }
    if (mode === "sse") {
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      pushSseLines(lines);
    } else {
      feedJson(text);
    }
  };

  return {
    /** The next event's JSON text, or null when the stream has ended. */
    async next(): Promise<string | null> {
      for (;;) {
        if (queue.length) return queue.shift() as string;
        if (ended) return null;
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          if (mode === "sse" && lineBuffer) pushSseLines([lineBuffer]);
          lineBuffer = "";
          continue;
        }
        feed(decoder.decode(value, { stream: true }));
      }
    },
    cancel(): void {
      reader.cancel().catch(() => {});
    },
  };
}
