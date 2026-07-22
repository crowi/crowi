'use client';

import { memo, useState } from 'react';
import { Plus } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const PRESENTATION_KEBAB = 'data-crowi-renderer-presentation';
const PRESENTATION_CAMEL = 'dataCrowiRendererPresentation';
const STATE_KEBAB = 'data-crowi-renderer-state';
const STATE_CAMEL = 'dataCrowiRendererState';

/**
 * `hast-util-to-jsx-runtime` delivers unrecognised `data-*` properties to
 * component overrides in camelCase in the common case, but (mirroring the
 * defensive read already used for `data-crowi-image-*` in
 * `editor/image-display.ts`) some versions hand them through hyphenated
 * instead — read/accept both forms so neither is missed regardless of
 * library version.
 */
function readTransportString(props: Record<string, unknown>, kebabKey: string, camelKey: string): string | undefined {
  const value = props[kebabKey] ?? props[camelKey];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The two renderer-presentation marker attributes, pre-extracted from a
 * source element's rest-props bag so the caller can re-apply them onto
 * `RendererPresentation`'s wrapper `<span>` — see that component's doc
 * comment for why the wrapper (not just the inner content) needs to carry
 * them (CSS selector contract, spec §3.1). Absent for legacy
 * `.diagram-embed` markup, which has no data-attribute contract to forward.
 */
export interface RendererPresentationAttrs {
  'data-crowi-renderer-presentation'?: string;
  'data-crowi-renderer-state'?: string;
}

export function pickRendererPresentationAttrs(rest: Record<string, unknown>): RendererPresentationAttrs {
  const attrs: RendererPresentationAttrs = {};
  const presentation = readTransportString(rest, PRESENTATION_KEBAB, PRESENTATION_CAMEL);
  const state = readTransportString(rest, STATE_KEBAB, STATE_CAMEL);
  if (presentation !== undefined) attrs[PRESENTATION_KEBAB] = presentation;
  if (state !== undefined) attrs[STATE_KEBAB] = state;
  return attrs;
}

/**
 * True when a server-rendered embed opts into the core, producer-agnostic
 * "diagram" presentation contract (feature-renderer-plugin-boundary spec
 * §3.1) AND is `ready` — i.e. `data-crowi-renderer-presentation="diagram"`
 * `data-crowi-renderer-state="ready"`. `error` (or any other state) is
 * deliberately NOT ready: a fixed error placeholder renders as a plain
 * element, `role="status"` intact, with no zoom affordance — there is
 * nothing worth enlarging.
 *
 * Falls back to the legacy dual-accept rule (spec §3.3) ONLY when the new
 * contract's presentation attribute is entirely ABSENT: `className` carries
 * the shared `diagram-embed` marker AND no `*-error` suffix class. This is
 * the byte-identical predicate `isDiagramEmbed` used before the
 * generalisation — kept so already-persisted `renderedAst` (an optional
 * renderer plugin's diagram output cached before it emits the new
 * data-attribute contract, Phase 2) keeps its zoom / width / dark-canvas
 * behaviour with no migration. The legacy branch intentionally never checks
 * a specific producer's name — only the shared generic marker class shape.
 *
 * When the presentation attribute IS present but carries an unrecognised
 * value (only `"diagram"` is a real presentation kind today), that is
 * authoritative — it must NOT fall through to the legacy class check, which
 * exists solely to cover old saved content that predates the attribute.
 */
export function isDiagramPresentationReady(className: unknown, rest: Record<string, unknown>): boolean {
  const presentation = readTransportString(rest, PRESENTATION_KEBAB, PRESENTATION_CAMEL);
  if (presentation !== undefined) {
    return presentation === 'diagram' && readTransportString(rest, STATE_KEBAB, STATE_CAMEL) === 'ready';
  }
  if (typeof className !== 'string') return false;
  const classes = className.split(/\s+/);
  if (!classes.includes('diagram-embed')) return false;
  return !classes.some((c) => c.endsWith('-error'));
}

interface RendererPresentationProps {
  /** The diagram body — an inline `<svg>` (SVG path) or `<img>` (PNG / data-URL path). */
  children: React.ReactNode;
  /** The server-emitted wrapper `className` (includes `diagram-embed` on the legacy path). */
  className?: string;
  /**
   * The renderer-presentation data attributes to re-apply onto the wrapper
   * `<span>` (see {@link pickRendererPresentationAttrs}) — absent on the
   * legacy `.diagram-embed` path, which has no data-attribute contract.
   */
  presentationAttrs?: RendererPresentationAttrs;
}

/**
 * Wraps a server-rendered "diagram" presentation (an optional renderer
 * plugin's diagram output today — this component itself has no
 * producer-specific knowledge) so it
 * (a) never overflows the article column — the inline diagram is capped to
 * the body width by the CSS rules in `globals.css` targeting both the new
 * `[data-crowi-renderer-presentation="diagram"][data-crowi-renderer-state=
 * "ready"]` selector and the legacy `.diagram-embed` class — and (b) can be
 * enlarged: hovering reveals a `+` affordance and a click opens a
 * near-full-screen lightbox where the diagram renders at natural size with
 * scroll/pan, so a wide sequence diagram stays readable.
 *
 * The diagram body is reused verbatim inside the lightbox. Because the
 * lightbox renders outside `.crowi-prose`, the cap-to-width rules don't
 * apply there, so the SVG/PNG falls back to its intrinsic size. Diagram
 * renderers bake black strokes on a transparent canvas (see the `.dark`
 * CSS note in `globals.css`), so the lightbox sits on a white surface in
 * both themes to keep the diagram legible.
 *
 * Memoized so that a markdown re-render (e.g. typing in the editor preview, a
 * route-level state change) does not unmount the dialog when it is open —
 * `children` from hast-util-to-jsx-runtime is a stable subtree per node, and
 * `className`/`presentationAttrs` only change when the embed itself changes.
 * Without memo, the dialog snaps shut every time the parent renders.
 */
export const RendererPresentation = memo(function RendererPresentation({ children, className, presentationAttrs }: RendererPresentationProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <span className={cn(className, 'group/diagram relative inline-block max-w-full')} {...presentationAttrs}>
        {children}
        {/* The `+` corner button is the only enlarge trigger — we deliberately
            do NOT wrap the diagram in a <button>, so any `<a href>` a diagram
            renderer emits inside the SVG stays a working link (and we avoid
            nesting interactive controls). Revealed on hover and on keyboard
            focus (`focus-visible:opacity-100`), mirroring the code-copy
            button. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={m['page.diagram_zoom']()}
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/diagram:opacity-100"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex w-full max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-4rem)]">
          <DialogTitle className="sr-only">{m['page.diagram_zoom']()}</DialogTitle>
          {/* Natural-size diagram on a white canvas. Top-left aligned (not
              flex-centered): a diagram wider/taller than the modal must
              stay fully reachable by scrolling — centering would strand the
              top-left edge of a large diagram out of scroll range. */}
          <div className="min-h-0 flex-1 overflow-auto bg-white p-4">{children}</div>
        </DialogContent>
      </Dialog>
    </>
  );
});
