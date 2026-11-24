// Echo handling for voice interruptions ("barge-in"). Pure functions, no imports.
//
// While KenBot is speaking, the microphone may pick up KenBot's own voice. Before treating
// what the recogniser heard as the person interrupting, we compare it with what KenBot is
// saying. Words that KenBot just said are very likely echo; new words are likely the person.

const STOP_WORDS = new Set(["stop", "wait", "pause", "enough", "cancel", "hold", "quiet", "shush"]);

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s.,;:!?"“”()\[\]{}…—–-]+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** Is this text, heard while KenBot is talking, really the person speaking over it? */
export function shouldInterrupt(heard: string, spoken: string): boolean {
  const heardWords = normalizeWords(heard);
  if (heardWords.length === 0) return false;
  const spokenSet = new Set(normalizeWords(spoken).slice(-150));
  const novel = heardWords.filter((w) => !spokenSet.has(w));
  // A clear command ("stop", "wait") is enough on its own.
  if (novel.some((w) => STOP_WORDS.has(w))) return true;
  // Otherwise require at least two new words, and mostly new words, so echo and noise are ignored.
  return novel.length >= 2 && novel.length / heardWords.length >= 0.5;
}

/** Remove leading words that are just KenBot's own voice, keeping what the person said. */
export function stripEchoPrefix(heard: string, spoken: string, maxWords = 8): string {
  const spokenSet = new Set(normalizeWords(spoken).slice(-150));
  const words = heard.trim().split(/\s+/).filter(Boolean);
  let drop = 0;
  while (drop < Math.min(maxWords, words.length)) {
    const normalized = normalizeWords(words[drop]);
    if (normalized.length === 0) {
      drop++;
      continue;
    }
    if (STOP_WORDS.has(normalized[0]) || !normalized.every((w) => spokenSet.has(w))) break;
    drop++;
  }
  return words.slice(drop).join(" ");
}
