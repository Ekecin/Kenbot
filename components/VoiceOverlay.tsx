"use client";

import Image from "next/image";
import { useEffect } from "react";
import type { TurnSummary } from "@/lib/perf";
import type { VoicePace } from "@/lib/tts";

export type VoiceState = "listening" | "thinking" | "speaking";

const LABELS: Record<VoiceState, string> = {
  listening: "I'm listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

const HINTS: Record<VoiceState, string> = {
  listening: "Tap the orb when you've finished talking",
  thinking: "Tap the orb to cancel",
  speaking: "Tap the orb to interrupt me",
};

const PACES: { id: VoicePace; label: string }[] = [
  { id: "slow", label: "Slower" },
  { id: "normal", label: "Normal" },
  { id: "fast", label: "Faster" },
];

const ms = (v: number | undefined) => (v === undefined ? "–" : `${v} ms`);

export default function VoiceOverlay({
  state,
  caption,
  onOrb,
  onClose,
  pace,
  onPace,
  bargeIn,
  onBargeIn,
  debug,
  stats,
  medians,
  engine,
}: {
  state: VoiceState;
  caption: string;
  onOrb: () => void;
  onClose: () => void;
  pace: VoicePace;
  onPace: (pace: VoicePace) => void;
  bargeIn: boolean;
  onBargeIn: (on: boolean) => void;
  debug: boolean;
  stats: TurnSummary | null;
  medians: Partial<Record<keyof TurnSummary, number>> | null;
  engine: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="voice" role="dialog" aria-modal="true" aria-label="Voice conversation">
      <div className="voice-inner">
        <button
          type="button"
          className="orb"
          data-state={state}
          onClick={onOrb}
          aria-label={HINTS[state]}
        >
          <span className="ring" />
          <span className="ring r2" />
          <span className="spin" />
          <Image src="/avatar.webp" alt="" width={220} height={220} priority />
        </button>
        <h2 className="voice-label" aria-live="polite">
          {LABELS[state]}
        </h2>
        <p className="voice-caption">{caption}</p>
        <p className="voice-hint">{HINTS[state]}</p>

        <div className="voice-opts">
          <div className="seg" role="group" aria-label="Speaking speed">
            <span className="seg-label">Speed</span>
            {PACES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={pace === p.id ? "on" : ""}
                aria-pressed={pace === p.id}
                onClick={() => onPace(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={bargeIn} onChange={(e) => onBargeIn(e.target.checked)} />
            <span>
              Let me interrupt by speaking
              <small>Works best with headphones</small>
            </span>
          </label>
        </div>

        <button type="button" className="voice-end" onClick={onClose} autoFocus>
          End conversation
        </button>

        {debug && (
          <dl className="voice-debug" aria-label="Voice timings (development only)">
            <dt>Voice engine</dt>
            <dd>{engine}{stats?.fellBack ? " (fell back)" : ""}</dd>
            <dt>You stop → KenBot speaks</dt>
            <dd>{ms(stats?.voiceToVoice)}{medians?.voiceToVoice !== undefined ? ` · median ${medians.voiceToVoice}` : ""}</dd>
            <dt>Speech end → request sent</dt>
            <dd>{ms(stats?.speechToRequest)}</dd>
            <dt>Request → first text</dt>
            <dd>{ms(stats?.firstToken)}{medians?.firstToken !== undefined ? ` · median ${medians.firstToken}` : ""}</dd>
            <dt>Whole text reply</dt>
            <dd>{ms(stats?.generation)}</dd>
            <dt>Voice request → first audio</dt>
            <dd>{ms(stats?.firstSynthesis)}</dd>
            <dt>First audio → sound</dt>
            <dd>{ms(stats?.audioToPlayback)}</dd>
            <dt>Audio gaps</dt>
            <dd>{stats ? `${stats.gapCount} (longest ${stats.maxGap} ms)` : "–"}</dd>
            <dt>Request → done speaking</dt>
            <dd>{ms(stats?.totalSpeaking)}</dd>
            {stats?.serverTiming && (
              <>
                <dt>Server</dt>
                <dd>{stats.serverTiming}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}
