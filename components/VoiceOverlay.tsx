"use client";

import Image from "next/image";
import { useEffect } from "react";

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

export default function VoiceOverlay({
  state,
  caption,
  onOrb,
  onClose,
}: {
  state: VoiceState;
  caption: string;
  onOrb: () => void;
  onClose: () => void;
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
        <button type="button" className="voice-end" onClick={onClose} autoFocus>
          End conversation
        </button>
      </div>
    </div>
  );
}
