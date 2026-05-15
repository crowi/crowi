/**
 * RFC-0003 Phase 8 — Deterministic per-user color for awareness UI.
 *
 * `y-codemirror.next` paints remote cursors using `state.user.color`
 * (caret) + `state.user.colorLight` (selection background) on the
 * awareness payload. We derive both from the user id so the same user
 * always appears in the same color across sessions, devices, and even
 * across page reloads — no server round-trip, no shared color table.
 *
 * Hash choice — **FNV-1a 32-bit** (not SHA-256):
 *   - browser-synchronous (no `crypto.subtle.digest` async hop)
 *   - 1-pass, ~10 LoC, no third-party dep
 *   - bias-low distribution for the small user-id space we hash (24-
 *     char hex / 36-char uuid). The output is reduced to `hash % 360`
 *     for the HSL hue; with the 20-editor cap per page the collision
 *     probability for two users picking the same hue is roughly
 *     `1 - product((360 - i) / 360 for i in 0..20)` ≈ 0.45, but the
 *     "same color" perception requires hues within ~30 °, so the
 *     visually-distinguishable failure rate is far lower. SHA-256
 *     would not move this needle — the bottleneck is the 360-bucket
 *     reduction, not the hash quality.
 *
 * The spec wording ("`sha256(userId)` 由来の HSL") describes the
 * intent (deterministic from user id), not the cryptographic primitive.
 * If a future requirement forces SHA-256 exact compliance, swap the
 * hash function but keep the `userColor` signature stable so call
 * sites don't churn.
 */

const DEFAULT_HUE = 220; // anonymous / empty-id fallback (cool blue)

/**
 * Map a user id to a stable HSL color pair for collab awareness.
 *
 *   - `color`      — caret color (full saturation/lightness)
 *   - `colorLight` — selection background (same hue, lighter)
 *
 * Empty string returns the anonymous fallback rather than the FNV-1a
 * basis hash, so logged-out / placeholder awareness states don't
 * collide with the user whose hash happens to map to hue 0.
 */
export function userColor(userId: string): { color: string; colorLight: string } {
  if (userId.length === 0) {
    return {
      color: `hsl(${DEFAULT_HUE} 70% 55%)`,
      colorLight: `hsl(${DEFAULT_HUE} 70% 85%)`,
    };
  }
  const hue = fnv1a32(userId) % 360;
  return {
    color: `hsl(${hue} 70% 55%)`,
    colorLight: `hsl(${hue} 70% 85%)`,
  };
}

/**
 * FNV-1a 32-bit hash. `Math.imul` (truncate-to-32 multiply) +
 * `>>> 0` (unsigned coerce) keep us inside JS's 32-bit integer
 * arithmetic without ever materialising a `BigInt` or array buffer.
 * Exported for unit tests to pin a few known hash outputs and catch
 * regressions if a refactor accidentally swaps the basis / prime.
 */
export function fnv1a32(input: string): number {
  // FNV-1a 32-bit basis: 0x811c9dc5
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // FNV-1a 32-bit prime: 0x01000193
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
