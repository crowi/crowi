import type { RenderError, Reservation } from '@crowi/plugin-api';
import type { CacheSetReject } from './mongodb-cache';

/**
 * Phase 4 placeholder HTML generators. All output goes through fixed
 * templates inside this file — no plugin-supplied string is ever
 * inlined into the HTML other than the numeric `widthPx` / `heightPx`
 * / `aspectRatio`, which the plugin author declares in their
 * `EmbedRenderer.reservation`. Embed-tag args / URLs never reach
 * placeholder HTML.
 *
 * Class naming convention (RFC §"open questions"):
 *
 *   crowi-embed-placeholder            (always present)
 *   crowi-embed-placeholder-fixed      (variant 'fixed')
 *   crowi-embed-placeholder-aspect     (variant 'aspect')
 *   crowi-embed-placeholder-card       (variant 'card')
 *   crowi-embed-placeholder-card-{size} ('small' | 'medium' | 'large')
 *   crowi-embed-placeholder-error      (errorPlaceholder)
 *   crowi-embed-placeholder-error-{code}
 *
 * Tailwind classes are NOT included; web/globals.css owns the visual
 * styling. The server only emits the structural HTML so the web
 * client can hydrate it.
 */

/** Card sizes → recommended pixel heights for the placeholder skeleton. */
const CARD_SIZE_TO_HEIGHT_PX: Record<'small' | 'medium' | 'large', number> = {
  small: 80,
  medium: 160,
  large: 280,
};

/**
 * Build the placeholder HTML for a given `Reservation`. Numeric
 * values are coerced to integers via `Math.max(0, Math.round(n))` so
 * a bogus float / negative declaration never produces malformed
 * style attributes.
 */
export function renderReservation(reservation: Reservation): string {
  if (reservation.variant === 'fixed') {
    const height = clampDimension(reservation.heightPx);
    const widthAttr = reservation.widthPx !== undefined ? `width:${clampDimension(reservation.widthPx)}px;` : '';
    return [
      '<div class="crowi-embed-placeholder crowi-embed-placeholder-fixed"',
      ` style="${widthAttr}height:${height}px;"`,
      ' aria-hidden="true"></div>',
    ].join('');
  }
  if (reservation.variant === 'aspect') {
    // Clamp to a sane range so a `0` doesn't divide-by-zero and a
    // huge value doesn't render a multi-screen-tall placeholder.
    const ratio = clampRatio(reservation.aspectRatio);
    // CSS `aspect-ratio: w / h` — emit decimal so the browser parses
    // it as a number rather than a fraction.
    return ['<div class="crowi-embed-placeholder crowi-embed-placeholder-aspect"', ` style="aspect-ratio:${ratio};"`, ' aria-hidden="true"></div>'].join('');
  }
  // 'card'
  const size = reservation.size;
  const height = CARD_SIZE_TO_HEIGHT_PX[size];
  return [
    `<div class="crowi-embed-placeholder crowi-embed-placeholder-card crowi-embed-placeholder-card-${size}"`,
    ` style="height:${height}px;"`,
    ' aria-hidden="true"></div>',
  ].join('');
}

/**
 * Shared tail of every `*Placeholder` builder below: the same
 * `crowi-embed-placeholder-error` wrapper div, optional reservation
 * shape, and a `crowi-embed-placeholder-error-label` span — only the
 * class suffix, any extra attributes (e.g. `sizeLimitPlaceholder`'s
 * `data-reason`), and the label text vary per error kind.
 */
function buildErrorPlaceholderHtml(classSuffix: string, label: string, reservation: Reservation | undefined, extraAttrs = ''): string {
  const shapeHtml = reservation ? renderReservation(reservation) : '';
  return [
    `<div class="crowi-embed-placeholder crowi-embed-placeholder-error crowi-embed-placeholder-error-${classSuffix}"${extraAttrs} role="status">`,
    shapeHtml,
    `<span class="crowi-embed-placeholder-error-label">${label}</span>`,
    '</div>',
  ].join('');
}

/**
 * Placeholder HTML for a render error. The user-facing message comes
 * from a fixed table per error code; plugin-supplied `error.message`
 * never reaches the HTML (potential PII / API-key leak).
 */
export function errorPlaceholder(code: RenderError['code'], reservation: Reservation | undefined): string {
  return buildErrorPlaceholderHtml(code, ERROR_LABELS[code], reservation);
}

/**
 * Placeholder for a size-limit reject. We distinguish the two
 * sub-cases so admin telemetry / e2e tests can tell them apart.
 */
export function sizeLimitPlaceholder(reason: CacheSetReject, reservation: Reservation | undefined): string {
  const label = reason === 'entry-too-large' ? 'Embed exceeded the per-entry size limit' : 'Page exceeded the cumulative embed-cache quota';
  return buildErrorPlaceholderHtml('size-limit', label, reservation, ` data-reason="${reason}"`);
}

/**
 * Placeholder for the classification-C "too many admission-gated
 * dispatches in one pipeline run" case (feature-plugin-renderer-mermaid
 * spec §5 classification C / §6's per-pipeline-run dispatch-count cap).
 * Deliberately generic (no plugin-specific class name) — `collectCandidates`
 * (`../core/code-block-dispatch.ts`) enforces this cap for ANY
 * registration that declares `admissionControl`, not Mermaid
 * specifically, and never calls `cachedRender` / `acquireRenderSlot` for
 * the over-limit candidates (so this HTML is built directly, never
 * cached).
 */
export function dispatchLimitPlaceholder(limit: number, reservation: Reservation | undefined): string {
  return buildErrorPlaceholderHtml('dispatch-limit', `Too many diagrams in this document (limit: ${limit}) — this one was not rendered.`, reservation);
}

const ERROR_LABELS: Record<RenderError['code'], string> = {
  auth: 'Authentication required to render this embed.',
  rate_limit: 'Rate limit exceeded — try again later.',
  not_found: 'Embed source not found.',
  network: 'Embed is temporarily unavailable.',
  timeout: 'Embed render timed out.',
  unknown: 'Embed could not be rendered.',
};

function clampDimension(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(4096, Math.round(n)));
}

function clampRatio(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  // Trim to 4 decimals to keep the inline style stable across renders.
  return Math.round(Math.max(0.05, Math.min(20, n)) * 10_000) / 10_000;
}
