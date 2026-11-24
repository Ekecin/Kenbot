// Lightweight performance monitoring for the voice pipeline.
// Records timestamps (never text or personal data) for each conversational turn so the real
// bottleneck can be found. Marks are cheap; the dev panel and console table are optional.

export type TurnMark =
  | "speechEnd" // the person's last words were recognised
  | "committed" // the turn was judged complete and handed to the app
  | "requestSent" // the chat request was sent
  | "headers" // the chat response headers arrived
  | "firstToken" // first text of the reply arrived
  | "responseDone" // the whole text reply has arrived
  | "ttsRequested" // first speech-synthesis request for the reply
  | "firstAudioData" // first synthesized audio arrived
  | "playbackStart" // sound started playing
  | "finished"; // KenBot finished speaking

export interface TurnMetrics {
  id: number;
  mode: "voice" | "text";
  engine: string;
  marks: Partial<Record<TurnMark, number>>;
  gaps: number[];
  fellBack: boolean;
  interrupted: boolean;
  serverTiming?: string;
}

export interface TurnSummary {
  id: number;
  mode: "voice" | "text";
  engine: string;
  /** Speech end → request sent. */
  speechToRequest?: number;
  /** Request sent → first text token. */
  firstToken?: number;
  /** Request sent → whole text reply. */
  generation?: number;
  /** First synthesis request → first audio bytes. */
  firstSynthesis?: number;
  /** First audio bytes → sound playing. */
  audioToPlayback?: number;
  /** The headline number: person stops talking → KenBot starts talking. */
  voiceToVoice?: number;
  /** Request sent → KenBot finished speaking. */
  totalSpeaking?: number;
  gapCount: number;
  maxGap: number;
  fellBack: boolean;
  interrupted: boolean;
  serverTiming?: string;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const diff = (a?: number, b?: number) => (a !== undefined && b !== undefined && b >= a ? Math.round(b - a) : undefined);

export function summarize(t: TurnMetrics): TurnSummary {
  const m = t.marks;
  return {
    id: t.id,
    mode: t.mode,
    engine: t.engine,
    speechToRequest: diff(m.speechEnd, m.requestSent),
    firstToken: diff(m.requestSent, m.firstToken),
    generation: diff(m.requestSent, m.responseDone),
    firstSynthesis: diff(m.ttsRequested, m.firstAudioData),
    audioToPlayback: diff(m.firstAudioData, m.playbackStart),
    voiceToVoice: diff(m.speechEnd ?? m.requestSent, m.playbackStart),
    totalSpeaking: diff(m.requestSent, m.finished),
    gapCount: t.gaps.length,
    maxGap: t.gaps.length ? Math.round(Math.max(...t.gaps)) : 0,
    fellBack: t.fellBack,
    interrupted: t.interrupted,
    serverTiming: t.serverTiming,
  };
}

type Listener = (latest: TurnSummary, history: TurnSummary[]) => void;

class PerfMonitor {
  enabled = false;
  private current: TurnMetrics | null = null;
  private history: TurnSummary[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();

  /** Start a new turn. For voice turns pass the time the person stopped speaking. */
  begin(mode: "voice" | "text", speechEndAt?: number): void {
    // A turn that never finished (for example it was interrupted) is still worth keeping.
    if (this.current) this.finish();
    this.current = { id: ++this.seq, mode, engine: "none", marks: {}, gaps: [], fellBack: false, interrupted: false };
    if (speechEndAt !== undefined) this.current.marks.speechEnd = speechEndAt;
  }

  mark(name: TurnMark, at: number = now()): void {
    const turn = this.current;
    if (!turn) return;
    if (turn.marks[name] === undefined) turn.marks[name] = at; // keep the first occurrence
    if (name === "finished") this.finish();
  }

  gap(ms: number): void {
    this.current?.gaps.push(ms);
  }

  setEngine(name: string): void {
    if (this.current) this.current.engine = name;
  }

  flagFallback(): void {
    if (this.current) this.current.fellBack = true;
  }

  flagInterrupted(): void {
    if (this.current) this.current.interrupted = true;
  }

  setServerTiming(value: string | null): void {
    if (this.current && value) this.current.serverTiming = value;
  }

  now(): number {
    return now();
  }

  private finish(): void {
    const turn = this.current;
    if (!turn) return;
    this.current = null;
    const summary = summarize(turn);
    this.history = [...this.history.slice(-19), summary];
    if (this.enabled && typeof console !== "undefined") {
      // Timings only: no message text, no names, no keys.
      console.table({ [`turn ${summary.id} (${summary.mode}, ${summary.engine})`]: summary });
    }
    this.listeners.forEach((fn) => fn(summary, this.history));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Median of each measure across recent turns. */
  medians(): Partial<Record<keyof TurnSummary, number>> {
    const keys: (keyof TurnSummary)[] = ["voiceToVoice", "firstToken", "generation", "firstSynthesis", "audioToPlayback", "totalSpeaking", "maxGap"];
    const out: Partial<Record<keyof TurnSummary, number>> = {};
    for (const k of keys) {
      const values = this.history.map((h) => h[k]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      if (values.length) out[k] = values[Math.floor(values.length / 2)];
    }
    return out;
  }
}

export const perf = new PerfMonitor();
