// Speech text preparation and sentence chunking.
// Pure functions with no imports, so they run in the browser, on the server and in unit tests.

export type SpeechChunk = { text: string; pauseAfterMs: number };

/* ───────── Pronunciation, numbers and Markdown clean-up ───────── */

// Words the voice tends to get wrong. Add your own as you hear mistakes.
const PRONUNCIATIONS: Record<string, string> = {
  KenBot: "Ken Bot",
  Supabase: "Supa base",
  Vercel: "Ver-sell",
  "Next.js": "Next J S",
  "Node.js": "Node J S",
  TypeScript: "Type Script",
  JavaScript: "Java Script",
  GitHub: "Git Hub",
  npm: "N P M",
};

const CURRENCY: Record<string, [string, string]> = {
  "₦": ["naira", "kobo"],
  $: ["dollars", "cents"],
  "£": ["pounds", "pence"],
  "€": ["euros", "cents"],
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SCALE_WORDS: Record<string, string> = {
  k: "thousand", thousand: "thousand", m: "million", million: "million", bn: "billion", billion: "billion",
};

let pronunciationRegex: RegExp | null = null;
function pronunciations(): RegExp {
  if (!pronunciationRegex) {
    const keys = Object.keys(PRONUNCIATIONS)
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    pronunciationRegex = new RegExp("\\b(" + keys.join("|") + ")\\b", "g");
  }
  return pronunciationRegex;
}

/**
 * Turn Markdown-flavoured text into plain conversational text for a speech engine.
 * It removes formatting symbols and URLs and says numbers, dates, money and abbreviations
 * the way a person would. The written reply on screen is never changed by this.
 */
export function prepareForSpeech(md: string): string {
  let t = md;

  t = t.replace(/```[\s\S]*?```/g, " I've put the code in the chat. ");
  t = t.replace(/`([^`\n]*)`/g, "$1");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "");

  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  t = t.replace(/^\s*>\s?/gm, "");
  t = t.replace(/^\s*[-*+•]\s+/gm, "");
  t = t.replace(/^\s*\d+[.)]\s+/gm, "");
  t = t.replace(/\|/g, " ");

  // Emphasis markers, without touching things like snake_case or 2*3.
  t = t.replace(/(\*\*|__)([^*_\n]+)\1/g, "$2");
  t = t.replace(/~~([^~\n]+)~~/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2");
  t = t.replace(/\*/g, "");

  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "");

  // Money: ₦5,000 → "5,000 naira", $5.50 → "5 dollars 50 cents", $2.5m → "2.5 million dollars".
  t = t.replace(
    /([₦$£€])\s?(\d[\d,]*)(?:\.(\d{1,2}))?(\s?(?:k|m|bn|million|billion|thousand)(?![A-Za-z]))?/gi,
    (_m, symbol: string, whole: string, decimals: string | undefined, scale: string | undefined) => {
      const [major, minor] = CURRENCY[symbol];
      if (scale) {
        const word = SCALE_WORDS[scale.trim().toLowerCase()] ?? scale.trim();
        return `${whole}${decimals ? "." + decimals : ""} ${word} ${major}`;
      }
      if (decimals && Number(decimals) > 0) {
        const cents = decimals.length === 1 ? decimals + "0" : decimals;
        return `${whole} ${major} ${cents} ${minor}`;
      }
      return `${whole} ${major}`;
    },
  );

  t = t.replace(/(\d)\s?%/g, "$1 percent");
  t = t.replace(/(\d)\s?°\s?([CF])\b/g, (_m, n: string, u: string) => `${n} degrees ${u === "C" ? "Celsius" : "Fahrenheit"}`);
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m: string, y: string, mo: string, d: string) => {
    const month = Number(mo);
    const day = Number(d);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${day} ${MONTHS[month - 1]} ${y}` : m;
  });
  t = t.replace(/\b(\d{1,3})\s?[–-]\s?(\d{1,3})\b(?![-–]\d)/g, "$1 to $2");

  t = t.replace(/\be\.g\./gi, "for example,");
  t = t.replace(/\bi\.e\./gi, "that is,");
  t = t.replace(/\betc\./gi, "et cetera.");
  t = t.replace(/\bvs\.?(?=\s)/gi, "versus");
  t = t.replace(/\bapprox\./gi, "approximately");
  t = t.replace(/\bw\//gi, "with ");
  t = t.replace(/\bNo\.\s?(?=\d)/g, "number ");
  t = t.replace(/\bMr\./g, "Mister").replace(/\bMrs\./g, "Missus").replace(/\bDr\./g, "Doctor").replace(/\bProf\./g, "Professor");
  t = t.replace(/\s&\s/g, " and ");

  t = t.replace(pronunciations(), (m) => PRONUNCIATIONS[m] ?? m);

  t = t.replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

/* ───────── Sentence boundaries ───────── */

const ALWAYS_ABBR = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "gen", "col", "lt", "sgt", "capt", "rev", "hon",
  "vs", "e.g", "i.e", "approx", "fig", "cf", "ca", "u.s", "u.k",
]);
const SOFT_ABBR = new Set(["etc", "inc", "ltd", "co", "dept", "est", "corp"]);

const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r";

function consumeSpace(text: string, from: number): number {
  let k = from;
  while (k < text.length && isSpace(text[k])) k++;
  return k;
}

function wordBefore(text: string, index: number): string {
  let p = index - 1;
  while (p >= 0 && /[A-Za-z0-9.]/.test(text[p])) p--;
  return text.slice(p + 1, index);
}

function pauseFor(ch: string, ellipsis: boolean): number {
  if (ellipsis) return 180;
  if (ch === "?") return 140;
  if (ch === "!") return 110;
  return 120;
}

export type SentenceEnd = { end: number; pause: number; paragraph: boolean };

/**
 * Find the end of the first complete sentence at or after `start`.
 * Returns null when it cannot be sure yet (more text may still arrive), unless `final` is true.
 * Handles abbreviations (Dr., e.g.), initials (J. K.), decimals (3.5), ellipses, line breaks and
 * code fences.
 */
export function findSentenceEnd(text: string, start: number, final: boolean): SentenceEnd | null {
  const n = text.length;
  let i = start;
  while (i < n) {
    const ch = text[i];

    if (ch === "`" && text.startsWith("```", i)) {
      const close = text.indexOf("```", i + 3);
      if (close === -1) return final ? { end: n, pause: 200, paragraph: true } : null;
      return { end: consumeSpace(text, close + 3), pause: 200, paragraph: true };
    }

    if (ch === "\n") {
      const end = consumeSpace(text, i);
      const paragraph = text.slice(i, end).split("\n").length > 2;
      return { end, pause: paragraph ? 260 : 200, paragraph };
    }

    if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
      let j = i + 1;
      while (j < n && ".!?…".includes(text[j])) j++;
      const runLength = j - i;
      while (j < n && "\"'”’)]}*_".includes(text[j])) j++;
      const ellipsis = ch === "…" || runLength >= 3;

      if (j >= n) return final ? { end: n, pause: pauseFor(ch, ellipsis), paragraph: false } : null;
      if (!isSpace(text[j])) {
        i = j; // 3.5, example.com, e.g. and similar
        continue;
      }

      const k = consumeSpace(text, j);
      const next = k < n ? text[k] : "";

      if (ch === ".") {
        const word = wordBefore(text, i);
        const lower = word.toLowerCase();
        if (runLength === 1) {
          if (ALWAYS_ABBR.has(lower)) { i = j; continue; }
          if (/^[A-Z]$/.test(word)) { i = j; continue; } // initials: J. K. Rowling
          if (SOFT_ABBR.has(lower) && !(next && /[A-Z0-9]/.test(next))) { i = j; continue; }
          if (next && /[a-z]/.test(next)) { i = j; continue; } // lower-case next word: not a sentence end
        } else if (ellipsis && next && /[a-z]/.test(next)) {
          i = j; // "well... maybe" continues
          continue;
        }
        if (!next && !final) return null; // cannot tell yet
      }

      return { end: k, pause: pauseFor(ch, ellipsis), paragraph: text.slice(j, k).split("\n").length > 2 };
    }

    i++;
  }
  return null;
}

/* ───────── Chunking for streamed replies ───────── */

export interface ChunkerOptions {
  /** If the first sentence is still unfinished after this many characters, split at a clause. */
  firstClauseAt?: number;
  /** Combine later sentences until a chunk is about this long. */
  target?: number;
  /** Never make a chunk longer than this. */
  max?: number;
}

function clauseCut(rest: string): number {
  const m = /[,;:—–]\s/.exec(rest.slice(40));
  if (m) return 40 + m.index + 2;
  if (rest.length >= 200) {
    const sp = rest.lastIndexOf(" ", 160);
    return sp > 0 ? sp + 1 : 0;
  }
  return 0;
}

function splitLong(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.5) cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf("; ", max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max - 1;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * Turns a growing reply into speakable chunks.
 *  - The FIRST chunk is a single sentence (or clause), so speech starts as early as possible.
 *  - Later chunks combine sentences to about `target` characters, which gives better intonation
 *    and means far fewer synthesis requests than one per sentence.
 *  - Each chunk carries a pause that matches its punctuation (longer after a paragraph).
 */
export class SentenceChunker {
  private consumed = 0;
  private emitted = 0;
  private pending: { text: string; pause: number; paragraph: boolean }[] = [];
  private readonly opt: Required<ChunkerOptions>;

  constructor(options: ChunkerOptions = {}) {
    this.opt = {
      firstClauseAt: options.firstClauseAt ?? 90,
      target: options.target ?? 110,
      max: options.max ?? 260,
    };
  }

  reset(): void {
    this.consumed = 0;
    this.emitted = 0;
    this.pending = [];
  }

  /** Feed ALL reply text so far. Returns any chunks that are now ready to speak. */
  push(raw: string, final: boolean): SpeechChunk[] {
    if (raw.length < this.consumed) this.reset(); // a new reply started

    for (;;) {
      const hit = findSentenceEnd(raw, this.consumed, final);
      if (!hit) break;
      const text = raw.slice(this.consumed, hit.end);
      this.consumed = hit.end;
      if (text.trim()) this.pending.push({ text, pause: hit.pause, paragraph: hit.paragraph });
    }

    if (!final && this.emitted === 0 && this.pending.length === 0) {
      const rest = raw.slice(this.consumed);
      if (rest.length >= this.opt.firstClauseAt) {
        const cut = clauseCut(rest);
        if (cut > 0) {
          this.pending.push({ text: rest.slice(0, cut), pause: 70, paragraph: false });
          this.consumed += cut;
        }
      }
    }

    if (final) {
      const rest = raw.slice(this.consumed);
      this.consumed = raw.length;
      if (rest.trim()) this.pending.push({ text: rest, pause: 0, paragraph: true });
    }

    return this.drain(final);
  }

  /** Release finished sentences that are waiting to be combined (used when the text slows down). */
  flushPending(): SpeechChunk[] {
    return this.drain(true);
  }

  private drain(force: boolean): SpeechChunk[] {
    const out: SpeechChunk[] = [];
    while (this.pending.length) {
      const length = this.pending.reduce((sum, p) => sum + p.text.length, 0);
      const paragraphBreak = this.pending.some((p) => p.paragraph);
      if (this.emitted > 0 && !force && length < this.opt.target && !paragraphBreak) break;
      out.push(...this.take());
    }
    return out;
  }

  private take(): SpeechChunk[] {
    const parts: string[] = [];
    let pause = 0;
    let size = 0;
    while (this.pending.length) {
      const next = this.pending[0];
      if (parts.length && (size + next.text.length > this.opt.max || this.emitted === 0)) break;
      this.pending.shift();
      parts.push(next.text);
      size += next.text.length;
      pause = next.pause;
      if (next.paragraph || this.emitted === 0) break;
    }
    this.emitted++;
    const pieces = splitLong(parts.join(""), this.opt.max);
    const result: SpeechChunk[] = [];
    pieces.forEach((piece, index) => {
      const text = prepareForSpeech(piece);
      if (text) result.push({ text, pauseAfterMs: index === pieces.length - 1 ? pause : 60 });
    });
    return result;
  }
}
