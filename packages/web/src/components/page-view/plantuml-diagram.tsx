'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * True when a server-rendered embed carries the `plantuml-embed` class.
 * The PlantUML renderer plugin emits either `<div class="plantuml-embed">`
 * (inlined SVG, the default) or `<img class="plantuml-embed">` (PNG
 * fallback); both the show page and the editor preview route those through
 * {@link PlantumlDiagram}. `className` arrives as `unknown` from the
 * hast-util-to-jsx-runtime component map, so we narrow defensively.
 */
export function isPlantumlEmbed(className: unknown): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes('plantuml-embed');
}

interface PlantumlDiagramProps {
  /** The diagram body — an inline `<svg>` (SVG path) or `<img>` (PNG path). */
  children: React.ReactNode;
  /** The server-emitted wrapper `className` (includes `plantuml-embed`). */
  className?: string;
}

/**
 * Wraps a server-rendered PlantUML diagram so it (a) never overflows the
 * article column — the inline diagram is capped to the body width by the
 * `.crowi-prose .plantuml-embed` rules in `globals.css` — and (b) can be
 * enlarged: hovering reveals a `+` affordance and a click opens a
 * near-full-screen lightbox where the diagram renders at natural size with
 * scroll/pan, so a wide sequence diagram stays readable.
 *
 * The diagram body is reused verbatim inside the lightbox. Because the
 * lightbox renders outside `.crowi-prose`, the cap-to-width rules don't
 * apply there, so the SVG/PNG falls back to its intrinsic size. PlantUML
 * bakes black strokes on a transparent canvas (see the `.dark .plantuml-embed`
 * note in `globals.css`), so the lightbox sits on a white surface in both
 * themes to keep the diagram legible.
 */
export function PlantumlDiagram({ children, className }: PlantumlDiagramProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <span className={cn(className, 'group/diagram relative inline-block max-w-full')}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={m['page.plantuml_zoom']()}
          className="block w-full cursor-zoom-in appearance-none border-0 bg-transparent p-0 text-left"
        >
          {children}
        </button>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover/diagram:opacity-100"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </span>
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex w-full max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-4rem)]">
          <DialogTitle className="sr-only">{m['page.plantuml_zoom']()}</DialogTitle>
          {/* Natural-size diagram on a white canvas. Top-left aligned (not
              flex-centered): a diagram wider/taller than the modal must
              stay fully reachable by scrolling — centering would strand the
              top-left edge of a large diagram out of scroll range. */}
          <div className="min-h-0 flex-1 overflow-auto bg-white p-4">{children}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
