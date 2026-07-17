'use client';

import { memo, useState } from 'react';
import { Plus } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * True when a server-rendered embed carries the shared `diagram-embed`
 * marker class AND does not carry a renderer-specific error class (e.g.
 * `mermaid-error`, `plantuml-error`) — feature-plugin-renderer-mermaid
 * spec §9. Both `@crowi/plugin-renderer-plantuml` (`<div class="diagram-embed
 * plantuml-embed">` inlined SVG, or `<img class="diagram-embed
 * plantuml-embed">` PNG fallback) and `@crowi/plugin-renderer-mermaid`
 * (`<img class="diagram-embed mermaid-embed" alt="...">`) route through
 * this check; both the show page and the editor preview do. The error
 * class exclusion matters because a renderer's fixed accessible error
 * placeholder (e.g. `<div class="mermaid-embed mermaid-error"
 * role="status">`) deliberately never carries `diagram-embed` (see
 * `@crowi/plugin-renderer-mermaid`'s `ERROR_HTML`) — this function checks
 * the exclusion explicitly rather than relying solely on that other
 * invariant holding forever. `className` arrives as `unknown` from the
 * hast-util-to-jsx-runtime component map, so we narrow defensively.
 */
export function isDiagramEmbed(className: unknown): boolean {
  if (typeof className !== 'string') return false;
  const classes = className.split(/\s+/);
  if (!classes.includes('diagram-embed')) return false;
  return !classes.some((c) => c.endsWith('-error'));
}

interface DiagramEmbedProps {
  /** The diagram body — an inline `<svg>` (SVG path) or `<img>` (PNG / data-URL path). */
  children: React.ReactNode;
  /** The server-emitted wrapper `className` (includes `diagram-embed`). */
  className?: string;
}

/**
 * Wraps a server-rendered diagram (PlantUML or Mermaid) so it (a) never
 * overflows the article column — the inline diagram is capped to the body
 * width by the `.crowi-prose .diagram-embed` rules in `globals.css` — and
 * (b) can be enlarged: hovering reveals a `+` affordance and a click opens a
 * near-full-screen lightbox where the diagram renders at natural size with
 * scroll/pan, so a wide sequence diagram stays readable.
 *
 * The diagram body is reused verbatim inside the lightbox. Because the
 * lightbox renders outside `.crowi-prose`, the cap-to-width rules don't
 * apply there, so the SVG/PNG falls back to its intrinsic size. PlantUML
 * and Mermaid both bake black strokes on a transparent canvas (see the
 * `.dark .diagram-embed` note in `globals.css`), so the lightbox sits on a
 * white surface in both themes to keep the diagram legible.
 */
/**
 * Memoized so that a markdown re-render (e.g. typing in the editor preview, a
 * route-level state change) does not unmount the dialog when it is open —
 * `children` from hast-util-to-jsx-runtime is a stable subtree per node, and
 * `className` only changes when the embed itself changes. Without memo, the
 * dialog snaps shut every time the parent renders.
 */
export const DiagramEmbed = memo(function DiagramEmbed({ children, className }: DiagramEmbedProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <span className={cn(className, 'group/diagram relative inline-block max-w-full')}>
        {children}
        {/* The `+` corner button is the only enlarge trigger — we deliberately
            do NOT wrap the diagram in a <button>, so any `<a href>` PlantUML
            emits inside the SVG stays a working link (and we avoid nesting
            interactive controls). Revealed on hover and on keyboard focus
            (`focus-visible:opacity-100`), mirroring the code-copy button. */}
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
