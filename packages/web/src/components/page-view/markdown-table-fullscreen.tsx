'use client';

import { memo, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

type ChildrenProps = { children?: React.ReactNode };

/**
 * Page-view `table` override: wraps a rendered `<table>` so it can be
 * expanded into a near-fullscreen Radix `Dialog` on top of the existing
 * horizontal-scroll wrapper (the `overflow-x-auto` div below). Modeled on
 * `PlantumlDiagram` (`plantuml-diagram.tsx`) — a `memo`'d component that
 * owns its own `open` state — but the table itself is mounted in exactly
 * ONE place at a time (never cloned): inline while closed
 * (`{!open && table}`), inside the Dialog while open (`{open && table}`).
 * This "single mount" design is what keeps `id`/`url(#id)` references
 * inside the table subtree intact and makes any id-stripping /
 * subtree-rewriting machinery unnecessary.
 *
 * Table *identity* (guarding against an open dialog silently showing a
 * DIFFERENT logical table after a re-render swaps `hast-util-to-jsx-runtime`
 * positional keys) is NOT handled here — the page-view caller
 * (`page-content.tsx`) adds a whole-container `key={revisionId}` so a new
 * revision remounts the whole subtree and discards any stale `open` state.
 */
export const MarkdownTableFullscreen = memo(function MarkdownTableFullscreen({ children, ...props }: ChildrenProps) {
  const [open, setOpen] = useState(false);
  // Preserve the inline scroll wrapper's rendered height while the table is
  // hoisted into the Dialog, so removing the table from that wrapper doesn't
  // collapse it to 0px and shift surrounding layout / scroll position.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  // One-shot handoff of the inline scrollport's scrollLeft to the Dialog
  // scroll container (set in handleOpen, consumed+cleared by the dialog
  // container's callback ref below — `null` = nothing pending).
  const pendingDialogScrollLeft = useRef<number | null>(null);

  // An author can hide a raw `<table hidden>` / `<table aria-hidden="true">`.
  // `{...props}` already keeps the <table> itself hidden/AT-inert, but the
  // toolbar row + expand button are rendered OUTSIDE the table and would
  // otherwise stay a live "expand" affordance for a table the author
  // intentionally hid (clicking it opens a dialog on empty / hidden content).
  // The robust fix is to NOT RENDER the toolbar at all in that case, rather
  // than propagate the attribute onto the wrapper and hope it's enough:
  // `hidden` (boolean) genuinely suppresses rendering/focusability via
  // `display:none`, but `aria-hidden="true"` on an ancestor ONLY hides the
  // subtree from the a11y tree — it does NOT make a descendant <button>
  // non-rendered, non-focusable or non-clickable. A wrapper merely marked
  // `aria-hidden="true"` would therefore leave a still-visible, Tab-reachable,
  // clickable "expand" control that is invisible only to screen readers —
  // itself an a11y anti-pattern (interactive content inside an aria-hidden
  // subtree). So we treat BOTH `hidden` and `aria-hidden="true"` uniformly as
  // "this table gets no interactive affordance" and skip rendering the toolbar
  // entirely. Read the STANDARD `hidden` (boolean attr) + `aria-hidden` off
  // `props` (both spellings, mirroring `TargetedSection`'s defensive `data-*`
  // read at `page-content.tsx:45-54`). We deliberately do NOT branch on
  // class-name heuristics like `class="hidden"` (that would interpret a
  // raw-HTML class for behaviour, crossing the RFC-0015 trust boundary).
  const propBag = props as Record<string, unknown>;
  // `hidden` is an OVERLOADED boolean (property-information models it so):
  // raw HTML keeps non-empty values as strings, so `<table hidden>` arrives
  // as `true`/`''` but `<table hidden="until-found">` (and any other
  // present-with-value spelling — per the HTML spec ANY present value means
  // hidden, `until-found` meaning hidden-until-revealed-by-find) arrives as
  // a non-empty STRING. Treat every present, non-false value as hidden.
  const tableHidden = propBag.hidden != null && propBag.hidden !== false;
  // `aria-hidden` values are likewise matched case-insensitively (same
  // enumerated-value reasoning as `contenteditable` below — the pipeline
  // preserves author casing, so `aria-hidden="TRUE"` must still count).
  const rawAriaHidden = propBag['aria-hidden'] ?? propBag.ariaHidden;
  const tableAriaHidden = typeof rawAriaHidden === 'string' && rawAriaHidden.toLowerCase() === 'true';
  // The table ELEMENT ITSELF can carry `contenteditable` (raw
  // `<table contenteditable>` — the whole table becomes one editable region
  // whose in-progress DOM edits the open/close (and revision) remount would
  // discard). Read it off the table's OWN props with the same value
  // semantics as `hidden`/`aria-hidden` above. HTML enumerated-attribute
  // values are case-insensitive and the raw-HTML pipeline preserves author
  // casing, so ASCII-lowercase the string before comparing (so
  // `contenteditable="TRUE"` / `"PLAINTEXT-ONLY"` still match).
  const ownEditable = propBag.contentEditable;
  const normalizedEditable = typeof ownEditable === 'string' ? ownEditable.toLowerCase() : ownEditable;
  const tableContentEditable =
    normalizedEditable === true || normalizedEditable === '' || normalizedEditable === 'true' || normalizedEditable === 'plaintext-only';
  // Skip the whole affordance (toolbar + trigger) ONLY on one-line reads of
  // the table's OWN standard attributes: the author hid it (`hidden` /
  // `aria-hidden`) or made the table itself contenteditable. We deliberately
  // do NOT walk descendants or inspect ancestors to detect form/interactive
  // content — that proved unbounded (documented known limitation). The
  // <table> itself still carries its own `hidden`/`aria-hidden`/`contenteditable`
  // via `{...props}`; we only suppress the OUTSIDE-the-table chrome.
  const affordanceHidden = tableHidden || tableAriaHidden || tableContentEditable;

  // Rendered ONCE, placed in exactly one location at a time. `{...props}`
  // passes every author attribute (raw-HTML `class`, `hidden`, `aria-hidden`,
  // data attrs, …) through to the <table> unmodified.
  const table = (
    <table className="w-full border-collapse text-sm" {...props}>
      {children}
    </table>
  );

  const handleOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    // Measure BEFORE opening — layout is still stable at this point.
    setMinHeight(scrollRef.current?.offsetHeight);
    // Carry the user's horizontal scroll position into the Dialog: on a
    // wide table the user expands to see MORE of the region they were
    // already looking at — resetting them to column 1 would discard that
    // context. Captured here (pre-open, scrollport still live), applied
    // once by the dialog scroll container's callback ref below, then
    // cleared so later re-renders never clobber in-dialog scrolling.
    pendingDialogScrollLeft.current = scrollRef.current?.scrollLeft ?? 0;
    // `preventDefault()` + `stopPropagation()` do DOUBLE duty:
    // (1) The open mechanism itself: the child onClick runs BEFORE Radix's
    //     Slot-side composed onClick, and that composed handler SKIPS
    //     `onOpenToggle` once `event.defaultPrevented` is set, making our
    //     `setOpen(true)` the single, deterministic open path.
    // (2) The ancestor-anchor click race: a table wrapped by `<a href>` /
    //     Next `<Link>` (or `<button>`/`<label>`) STILL renders this trigger
    //     — we no longer detect/suppress interactive ancestors (documented
    //     known limitation) — so a click would otherwise also fire native
    //     navigation / the ancestor's onClick. `preventDefault()` cancels the
    //     native navigation and `stopPropagation()` blocks the ancestor
    //     listener, so the click only opens the dialog. (The residual
    //     nested-interactive-markup a11y impurity is part of that documented
    //     limitation.)
    // On an ordinary table with no interactive ancestor both calls are
    // effectively no-ops (a `type="button"` has no default action and there
    // is no ancestor listener), so applying them unconditionally is safe.
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  return (
    <div className="group/table relative my-6">
      {/* Toolbar row: OUTSIDE the scrollport. Skipped ENTIRELY when the author
          hid the table (`hidden` / `aria-hidden="true"`), so a deliberately-
          hidden table shows no live expand control — we do NOT rely on
          propagating `aria-hidden` (which would leave a focusable/clickable
          button, see `affordanceHidden` above). When rendered it stays present
          regardless of open/close. */}
      {!affordanceHidden && (
        <div className="flex justify-end">
          <Dialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) setMinHeight(undefined);
            }}
          >
            <DialogTrigger asChild>
              <button
                type="button"
                onClick={handleOpen}
                aria-label={m['page.table_fullscreen_open']()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground opacity-40 backdrop-blur transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover/table:opacity-100 pointer-coarse:opacity-100"
              >
                <Maximize2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </DialogTrigger>
            {/* `aria-describedby={undefined}` suppresses Radix's always-set
                dangling describedby reference (no DialogDescription rendered) —
                mirrors `live-presence-row.tsx:147`. */}
            <DialogContent
              aria-describedby={undefined}
              className="flex w-full max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-4rem)]"
            >
              <DialogTitle className="sr-only">{m['page.table_fullscreen_open']()}</DialogTitle>
              {/* `pt-10` reserves clearance for DialogContent's built-in close
                  button (dialog.tsx:59-66, `absolute top-4 right-4` size-4 icon)
                  so it never overlaps the table's top-right cells. The callback
                  ref applies the carried-over scrollLeft exactly once per open
                  (inline arrow = new identity per render = React re-invokes it,
                  so the consume-and-clear guard is what prevents later renders
                  from clobbering the user's in-dialog scrolling). */}
              <div
                ref={(el) => {
                  if (el && pendingDialogScrollLeft.current != null) {
                    el.scrollLeft = pendingDialogScrollLeft.current;
                    pendingDialogScrollLeft.current = null;
                  }
                }}
                className="crowi-prose min-h-0 flex-1 overflow-auto px-4 pb-4 pt-10"
              >
                {open && table}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}
      {/* Inline table: only mounted while the dialog is CLOSED. The measured
          `minHeight` keeps this wrapper from collapsing to 0px while the
          table lives in the Dialog. */}
      <div ref={scrollRef} className="overflow-x-auto" style={open ? { minHeight } : undefined}>
        {!open && table}
      </div>
    </div>
  );
});
