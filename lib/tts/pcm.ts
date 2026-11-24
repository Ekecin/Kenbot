// Small audio helpers for raw 16-bit PCM (24 kHz, mono) as produced by Gemini TTS streaming.
// Pure functions, no imports.

export const SAMPLE_RATE = 24000;

/** Convert little-endian 16-bit PCM bytes to floats, carrying over a stray odd byte between chunks. */
export function pcm16ToFloat32(
  bytes: Uint8Array,
  carry: Uint8Array | null,
): { samples: Float32Array; carry: Uint8Array | null } {
  let data = bytes;
  if (carry && carry.length) {
    data = new Uint8Array(carry.length + bytes.length);
    data.set(carry, 0);
    data.set(bytes, carry.length);
  }
  const usable = data.length - (data.length % 2);
  const samples = new Float32Array(usable / 2);
  for (let i = 0, o = 0; i < usable; i += 2, o++) {
    const v = ((data[i] | (data[i + 1] << 8)) << 16) >> 16; // sign-extend
    samples[o] = v / 32768;
  }
  return { samples, carry: usable < data.length ? data.slice(usable) : null };
}

/** Index of the first sample louder than `threshold` within the first `limit` samples, or -1. */
export function firstSoundIndex(s: Float32Array, threshold = 0.012, limit = s.length): number {
  const end = Math.min(limit, s.length);
  for (let i = 0; i < end; i++) if (Math.abs(s[i]) > threshold) return i;
  return -1;
}

/** Index of the last sample louder than `threshold`, or -1 if the clip is silent. */
export function lastSoundIndex(s: Float32Array, threshold = 0.012): number {
  for (let i = s.length - 1; i >= 0; i--) if (Math.abs(s[i]) > threshold) return i;
  return -1;
}

/** Short linear fades to avoid clicks where chunks are joined. Edits the array in place. */
export function applyFade(s: Float32Array, fadeInSamples: number, fadeOutSamples: number): void {
  const fi = Math.min(fadeInSamples, s.length);
  for (let i = 0; i < fi; i++) s[i] *= i / fi;
  const fo = Math.min(fadeOutSamples, s.length);
  for (let i = 0; i < fo; i++) s[s.length - 1 - i] *= i / fo;
}

export function concatFloat32(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
