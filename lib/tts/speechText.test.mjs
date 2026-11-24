// Unit tests for speech preparation, chunking, echo filtering and PCM helpers.
// Run with: npm run test:speech   (needs Node 22.6 or newer)
import test from "node:test";
import assert from "node:assert/strict";
import { prepareForSpeech, findSentenceEnd, SentenceChunker } from "./speechText.ts";
import { shouldInterrupt, stripEchoPrefix, normalizeWords } from "./echo.ts";
import { pcm16ToFloat32, firstSoundIndex, lastSoundIndex, applyFade, concatFloat32 } from "./pcm.ts";

const chunksOf = (text, options) => {
  const c = new SentenceChunker(options);
  return c.push(text, true).map((x) => x.text);
};

/* ───── prepareForSpeech ───── */

test("removes Markdown without losing meaning", () => {
  assert.equal(prepareForSpeech("## Heading\n**Bold** and *italic* and `code`."), "Heading Bold and italic and code.");
  assert.equal(prepareForSpeech("- one\n- two\n1. three"), "one two three");
  assert.equal(prepareForSpeech("[Google](https://google.com) is big"), "Google is big");
});

test("drops URLs, emoji and code blocks", () => {
  assert.equal(prepareForSpeech("See https://example.com/x?y=1 now 😊"), "See now");
  assert.match(prepareForSpeech("Try this:\n```js\nconst a = 1;\n```\nDone."), /put the code in the chat/);
  assert.equal(prepareForSpeech("🎉"), "");
});

test("says money, percent, dates and ranges naturally", () => {
  assert.equal(prepareForSpeech("It costs ₦5,000 today"), "It costs 5,000 naira today");
  assert.equal(prepareForSpeech("Only $5.50 each"), "Only 5 dollars 50 cents each");
  assert.equal(prepareForSpeech("Raised $2.5m"), "Raised 2.5 million dollars");
  assert.equal(prepareForSpeech("Up 50% since 2026-11-14"), "Up 50 percent since 14 November 2026");
  assert.equal(prepareForSpeech("Pages 10-20 and 25°C"), "Pages 10 to 20 and 25 degrees Celsius");
  assert.equal(prepareForSpeech("Call 080-123-4567"), "Call 080-123-4567");
});

test("expands abbreviations and applies pronunciations", () => {
  assert.equal(prepareForSpeech("Use tools, e.g. npm"), "Use tools, for example, N P M");
  assert.equal(prepareForSpeech("Dr. Okoye uses Next.js"), "Doctor Okoye uses Next J S");
  assert.equal(prepareForSpeech("snake_case stays"), "snake_case stays");
});

/* ───── sentence boundaries ───── */

test("does not split on abbreviations, initials or decimals", () => {
  // Only the real sentence ends split the text; "Dr." and "J. K." and "3.5" do not.
  assert.deepEqual(chunksOf("Dr. Smith met J. K. Rowling. It cost 3.5 million."), ["Doctor Smith met J. K. Rowling.", "It cost 3.5 million."]);
  assert.deepEqual(chunksOf("Visit example.com for more. Thanks!", { target: 10 }), ["Visit example.com for more.", "Thanks!"]);
  assert.deepEqual(chunksOf("I like e.g. cats. Dogs too."), ["I like for example, cats.", "Dogs too."]);
});

test("first chunk is a single sentence for a fast start", () => {
  const c = new SentenceChunker();
  const out = c.push("Sure thing. I can help with that. Let me explain how it works. ", false);
  assert.equal(out[0].text, "Sure thing.");
});

test("later sentences are combined to reduce requests", () => {
  const c = new SentenceChunker({ target: 60 });
  const out = c.push("First. Second sentence is here. Third one follows right behind it. Fourth ends it. ", false);
  assert.ok(out.length >= 1);
  assert.equal(out[0].text, "First.");
  const rest = [...out.slice(1), ...c.push("First. Second sentence is here. Third one follows right behind it. Fourth ends it. ", true)];
  assert.ok(rest.some((x) => x.text.includes("Second sentence is here. Third")));
});

test("streaming character by character gives the same chunks as feeding it all at once", () => {
  const text = "Hello there! I'm KenBot. Dr. Smith said it costs $5.50, e.g. today. Wait... really? Yes.\n\nNew paragraph here.";
  const whole = chunksOf(text);
  const c = new SentenceChunker();
  const streamed = [];
  for (let i = 1; i <= text.length; i++) streamed.push(...c.push(text.slice(0, i), i === text.length).map((x) => x.text));
  assert.deepEqual(streamed.join(" "), whole.join(" "));
});

test("handles unfinished text at the end of a stream", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Hello world", false), []);
  assert.deepEqual(c.push("Hello world and more", true).map((x) => x.text), ["Hello world and more"]);
});

test("splits very long unpunctuated text and respects max length", () => {
  const long = "word ".repeat(120);
  const out = chunksOf(long, { max: 100 });
  assert.ok(out.length > 3);
  assert.ok(out.every((x) => x.length <= 105));
});

test("pauses match punctuation", () => {
  const c = new SentenceChunker();
  const [q] = c.push("Really? ", false);
  assert.equal(q.pauseAfterMs, 140);
});

test("findSentenceEnd waits when it cannot be sure", () => {
  // After a full stop it needs to see the next word to rule out abbreviations like "e.g."
  assert.equal(findSentenceEnd("Hello there.", 0, false), null);
  assert.equal(findSentenceEnd("Hello there. ", 0, false), null);
  assert.ok(findSentenceEnd("Hello there. I", 0, false));
  assert.ok(findSentenceEnd("Hello there.", 0, true));
  // Question and exclamation marks are certain.
  assert.ok(findSentenceEnd("Really? ", 0, false));
});

test("a restarted reply resets the chunker", () => {
  const c = new SentenceChunker();
  c.push("A long first reply here. More text follows. ", false);
  const out = c.push("Hi. There", false);
  assert.equal(out[0].text, "Hi.");
});

/* ───── echo filter ───── */

test("echo of KenBot's own words is not an interruption", () => {
  const spoken = "The capital of France is Paris and it sits on the river Seine";
  assert.equal(shouldInterrupt("capital of France is Paris", spoken), false);
  assert.equal(shouldInterrupt("", spoken), false);
});

test("new words or commands interrupt", () => {
  const spoken = "The capital of France is Paris";
  assert.equal(shouldInterrupt("no I meant Germany", spoken), true);
  assert.equal(shouldInterrupt("stop", spoken), true);
  assert.equal(shouldInterrupt("uh", spoken), false);
});

test("stripEchoPrefix keeps what the person said", () => {
  const spoken = "the capital of France is Paris";
  assert.equal(stripEchoPrefix("of France is wait what about Spain", spoken), "wait what about Spain");
  assert.equal(stripEchoPrefix("what about Spain", spoken), "what about Spain");
  assert.deepEqual(normalizeWords("Hello, World! It's me."), ["hello", "world", "it's", "me"]);
});

/* ───── PCM helpers ───── */

test("decodes 16-bit PCM and carries an odd byte", () => {
  const first = pcm16ToFloat32(new Uint8Array([0x00, 0x40, 0xff]), null);
  assert.equal(first.samples.length, 1);
  assert.ok(Math.abs(first.samples[0] - 0.5) < 0.001);
  assert.equal(first.carry.length, 1);
  const second = pcm16ToFloat32(new Uint8Array([0x7f]), first.carry);
  assert.equal(second.samples.length, 1);
  assert.ok(second.samples[0] > 0.99);
  const negative = pcm16ToFloat32(new Uint8Array([0x00, 0x80]), null);
  assert.equal(negative.samples[0], -1);
});

test("finds silence edges, fades and concatenates", () => {
  const s = new Float32Array(100);
  for (let i = 30; i < 60; i++) s[i] = 0.5;
  assert.equal(firstSoundIndex(s), 30);
  assert.equal(lastSoundIndex(s), 59);
  assert.equal(firstSoundIndex(new Float32Array(10)), -1);
  const loud = new Float32Array(10).fill(1);
  applyFade(loud, 4, 4);
  assert.equal(loud[0], 0);
  assert.equal(loud[9], 0);
  assert.equal(loud[5], 1);
  assert.equal(concatFloat32([new Float32Array(3), new Float32Array(4)]).length, 7);
});
