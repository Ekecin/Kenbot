"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, PaletteIcon } from "@/components/icons";

export type Theme = "purple" | "dark" | "light";

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "purple", label: "Purple mode", hint: "Deep-space glow" },
  { id: "dark", label: "Dark mode", hint: "Calm graphite" },
  { id: "light", label: "Light mode", hint: "Bright and airy" },
];

export default function ThemeMenu({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="theme-menu" ref={ref}>
      <button
        type="button"
        className={`icon-btn${open ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Change theme"
        title="Change theme"
      >
        <PaletteIcon />
      </button>
      {open && (
        <div className="theme-pop" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === theme}
              className={`theme-opt${t.id === theme ? " active" : ""}`}
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
            >
              <span className={`swatch swatch-${t.id}`} aria-hidden="true" />
              <span className="theme-txt">
                <strong>{t.label}</strong>
                <small>{t.hint}</small>
              </span>
              {t.id === theme && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
