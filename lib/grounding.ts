// Web-search grounding helpers shared by the server and the browser. Pure, no imports.
//
// When Gemini searches the web it returns sources and "Search Suggestions" (a small widget
// Google requires apps to display). The chat route appends them to the end of the streamed
// reply after a marker character, so the spoken/visible text can stream untouched and the
// sources arrive last. The same trailer is saved with the reply so history shows them too.

export const REPLY_MARKER = "\u0001";

export type ReplySource = { title: string; url: string };
export type ReplyMeta = { sources: ReplySource[]; suggestions?: string };

export function buildTrailer(meta: ReplyMeta): string {
  return REPLY_MARKER + JSON.stringify(meta);
}

function cleanMeta(value: unknown): ReplyMeta | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { sources?: unknown; suggestions?: unknown };
  const sources: ReplySource[] = [];
  if (Array.isArray(v.sources)) {
    for (const s of v.sources.slice(0, 8)) {
      const item = s as { title?: unknown; url?: unknown };
      if (typeof item?.url === "string" && /^https:\/\//i.test(item.url)) {
        sources.push({ url: item.url, title: typeof item.title === "string" && item.title ? item.title.slice(0, 80) : item.url });
      }
    }
  }
  const suggestions = typeof v.suggestions === "string" && v.suggestions.length < 30000 ? v.suggestions : undefined;
  return sources.length || suggestions ? { sources, suggestions } : null;
}

/** Split a streamed or saved reply into its text and (if complete) its sources. */
export function splitReply(full: string): { text: string; meta: ReplyMeta | null } {
  const i = full.indexOf(REPLY_MARKER);
  if (i === -1) return { text: full, meta: null };
  const text = full.slice(0, i).replace(/\s+$/, "");
  try {
    return { text, meta: cleanMeta(JSON.parse(full.slice(i + 1))) };
  } catch {
    return { text, meta: null }; // the trailer has not fully arrived yet
  }
}

/** Turn Gemini's groundingMetadata into the small structure KenBot shows. */
export function extractGrounding(groundingMetadata: unknown): ReplyMeta | null {
  const g = groundingMetadata as
    | {
        groundingChunks?: { web?: { uri?: string; title?: string } }[];
        searchEntryPoint?: { renderedContent?: string };
      }
    | null
    | undefined;
  if (!g) return null;
  const seen = new Set<string>();
  const sources: ReplySource[] = [];
  for (const chunk of g.groundingChunks ?? []) {
    const url = chunk?.web?.uri;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) continue;
    const title = (chunk.web?.title ?? "").trim() || url;
    if (seen.has(title)) continue; // one chip per site
    seen.add(title);
    sources.push({ url, title: title.slice(0, 80) });
    if (sources.length >= 5) break;
  }
  const suggestions = g.searchEntryPoint?.renderedContent;
  return cleanMeta({ sources, suggestions });
}
