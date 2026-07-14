import { syntaxTree } from '@codemirror/language';
import { MapMode, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { closeHoverTooltips, EditorView, hoverTooltip, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';

/**
 * RFC-0015 image display attributes — CodeMirror editor affordance
 * (§D13). A hover/focus tooltip over a Markdown image span (`![alt](url)`,
 * optionally followed by a `{width= align= float=}` attribute block)
 * lets the author set `width` / `align` / `float` without hand-typing
 * the `{...}` grammar.
 *
 * Registered as a BUILT-IN via `buildExtensions` (`build-extensions.ts`)
 * rather than threaded through `extraExtensions` — neither
 * `edit-page-client.tsx`'s normal nor collaborative branch passes
 * `extraExtensions` today, so putting it in `buildExtensions` is the
 * only way both editors get it without adding a new prop (§D13).
 *
 * This is an editing CONVENIENCE, not the source of truth: the API
 * core transform (`packages/api/src/renderer/core/image-attrs.ts`)
 * re-parses and re-validates the `{...}` block at render time
 * regardless of how it was authored, so this module intentionally does
 * NOT reject a value the user types into a control — the server-side
 * DROP-on-invalid rule (§D3) is what actually gates what takes visual
 * effect. Height has no dedicated control (out of the v1 editor UI per
 * §D13 — only width/align/float are exposed) but an existing
 * `height=` token is still parsed/preserved verbatim across edits made
 * through the other controls, so the affordance never silently
 * discards an attribute it doesn't have a widget for.
 */

/** The 4 allow-listed keys (mirrors `packages/api/src/renderer/core/image-attrs.ts` — kept in lockstep intentionally, this is the 3rd independent re-validation site after the API transform and the web render helper). */
export interface ParsedImageAttrs {
  width?: string;
  height?: string;
  align?: 'left' | 'center' | 'right';
  float?: 'left' | 'right';
}

/** A patch the affordance's controls (or a test) can apply — `undefined` clears the key. */
export type ImageAttrsPatch = Partial<Record<keyof ParsedImageAttrs, string | undefined>>;

const ALIGN_VALUES = new Set(['left', 'center', 'right']);
const FLOAT_VALUES = new Set(['left', 'right']);
// `<number>(%|px)` — deliberately NOT range-checked here (unlike the API
// transform's `validateSize`/web helper's `validateSize`): this parser only
// decides what to show as the control's CURRENT value and what to
// round-trip verbatim, not what is allowed to render. An out-of-range
// value the user typed directly still shows up (so they see what they
// wrote) and is only ever dropped at render time (§D3).
const SIZE_RE = /^\d+(?:\.\d+)?(%|px)$/;

/** Same bounded-scan window as the API transform (`MAX_ATTR_BODY_LEN`) — keeps a huge unterminated `{...` O(1)-ish to inspect instead of scanning the rest of the document. */
const MAX_ATTR_BODY_LEN = 1024;
/** Image → attribute-block prefix grammar, identical to the API transform's `PREFIX_RE`. */
const PREFIX_RE = /^(?:[ \t]*|\n[ \t]*)\{/;

/** One token (`key=value`) parsed from an existing attribute-block body. Recognised keys land in `attrs`; anything else — unknown key, malformed token, or a known key with a value this parser doesn't recognise as syntactically well-formed (still shown byte-for-byte) — is preserved verbatim in `unknownTokens` so a rewrite never silently drops author-typed text the affordance has no control for. */
function parseAttrBody(body: string): { attrs: ParsedImageAttrs; unknownTokens: string[] } {
  const attrs: ParsedImageAttrs = {};
  const unknownTokens: string[] = [];
  if (body === '') return { attrs, unknownTokens };
  for (const token of body.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      unknownTokens.push(token);
      continue;
    }
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1);
    if (value === '') {
      unknownTokens.push(token);
      continue;
    }
    if ((key === 'width' || key === 'height') && SIZE_RE.test(value)) {
      attrs[key] = value;
    } else if (key === 'align' && ALIGN_VALUES.has(value)) {
      attrs.align = value as 'left' | 'center' | 'right';
    } else if (key === 'float' && FLOAT_VALUES.has(value)) {
      attrs.float = value as 'left' | 'right';
    } else {
      unknownTokens.push(token);
    }
  }
  return { attrs, unknownTokens };
}

/** Reconstruct a `{...}` body from attrs + preserved unknown tokens. Empty attrs + no unknown tokens → `''` (caller removes the whole block). */
function buildAttrBlockBody(attrs: ParsedImageAttrs, unknownTokens: readonly string[]): string {
  const tokens: string[] = [];
  if (attrs.width) tokens.push(`width=${attrs.width}`);
  if (attrs.height) tokens.push(`height=${attrs.height}`);
  if (attrs.align) tokens.push(`align=${attrs.align}`);
  if (attrs.float) tokens.push(`float=${attrs.float}`);
  tokens.push(...unknownTokens);
  return tokens.join(' ');
}

/** The image span + (if present) its trailing attribute-block region, located fresh from the current document. */
export interface ImageAttrsTarget {
  /** Start of the `![alt](url)` syntax span. */
  imageFrom: number;
  /** End of the `![alt](url)` syntax span (exclusive). */
  imageTo: number;
  /** Start of the replace-region for a full block add/remove: `imageTo` when there's no block, or the start of the whitespace prefix when there is one. */
  regionFrom: number;
  /** End of the replace-region (exclusive): `imageTo` when there's no block, or just past the closing `}` when there is one. */
  regionTo: number;
  /** Start/end of just the body substring between `{`/`}` — only meaningful when `hasBlock` is true (used to rewrite the body in place, preserving the braces). */
  bodyFrom: number;
  bodyTo: number;
  hasBlock: boolean;
  attrs: ParsedImageAttrs;
  unknownTokens: string[];
  /**
   * Editor-side APPROXIMATION of the render-time standalone predicate
   * (§D7/AC-C5) — true when the image (+ its attribute block) is the
   * only non-whitespace content on its own line, and the adjacent
   * lines above/below (if any) are blank. Good enough to gate whether
   * align/float controls make sense to offer; the server transform
   * remains the actual source of truth for figure-vs-inline (it walks
   * the parsed mdast paragraph, not raw lines — a same-paragraph
   * multi-line case without a blank separator is a known gap this
   * heuristic doesn't chase).
   */
  standalone: boolean;
}

/** True when `state`'s syntax tree has an `Image` node containing `pos`. */
function findImageNodeRange(state: EditorState, pos: number): { from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.name !== 'Image') {
    if (!node.parent) return null;
    node = node.parent;
  }
  return node ? { from: node.from, to: node.to } : null;
}

function computeStandalone(doc: Text, imageFrom: number, regionTo: number): boolean {
  const startLine = doc.lineAt(imageFrom);
  const endLine = doc.lineAt(regionTo);
  // The attribute-block grammar (`PREFIX_RE`, mirroring the API
  // transform's AC-A8) allows AT MOST one soft line break between the
  // image and `{`, so a valid region spans at most 2 source lines
  // (the image's own line, and — only when that one soft break was
  // used — the attribute-block's line). Reject anything wider
  // defensively; `locateImageAttrsTarget` should never hand us more,
  // but this predicate doesn't want to depend on that invariant.
  if (endLine.number - startLine.number > 1) return false;
  const before = doc.sliceString(startLine.from, imageFrom);
  const after = doc.sliceString(regionTo, endLine.to);
  if (before.trim() !== '' || after.trim() !== '') return false;
  const prevLine = startLine.number > 1 ? doc.line(startLine.number - 1) : null;
  if (prevLine && prevLine.text.trim() !== '') return false;
  const nextLine = endLine.number < doc.lines ? doc.line(endLine.number + 1) : null;
  if (nextLine && nextLine.text.trim() !== '') return false;
  return true;
}

/**
 * Locate the image span (and its optional attribute block) at/around
 * `pos`, re-reading directly from `state.doc` every time it's called —
 * never from a cached offset (AC-C4: callers MUST call this again,
 * immediately before dispatching, rather than reusing a target
 * computed earlier).
 */
export function locateImageAttrsTarget(state: EditorState, pos: number): ImageAttrsTarget | null {
  const imageRange = findImageNodeRange(state, pos);
  if (!imageRange) return null;
  const { from: imageFrom, to: imageTo } = imageRange;
  const doc = state.doc;

  const noBlock = (): ImageAttrsTarget => ({
    imageFrom,
    imageTo,
    regionFrom: imageTo,
    regionTo: imageTo,
    bodyFrom: imageTo,
    bodyTo: imageTo,
    hasBlock: false,
    attrs: {},
    unknownTokens: [],
    standalone: computeStandalone(doc, imageFrom, imageTo),
  });

  const afterEnd = Math.min(doc.length, imageTo + 2 + MAX_ATTR_BODY_LEN);
  const after = doc.sliceString(imageTo, afterEnd);
  const prefixMatch = PREFIX_RE.exec(after);
  if (!prefixMatch) return noBlock();

  const bodyStart = imageTo + prefixMatch[0].length;
  const windowEnd = Math.min(doc.length, bodyStart + MAX_ATTR_BODY_LEN);
  const window = doc.sliceString(bodyStart, windowEnd);
  const relClose = window.indexOf('}');
  if (relClose === -1) return noBlock();

  const bodyEnd = bodyStart + relClose;
  const body = doc.sliceString(bodyStart, bodyEnd);
  if (body.includes('\n') || body !== body.trim()) return noBlock();

  const { attrs, unknownTokens } = parseAttrBody(body);
  const regionTo = bodyEnd + 1;
  return {
    imageFrom,
    imageTo,
    regionFrom: imageTo,
    regionTo,
    bodyFrom: bodyStart,
    bodyTo: bodyEnd,
    hasBlock: true,
    attrs,
    unknownTokens,
    standalone: computeStandalone(doc, imageFrom, regionTo),
  };
}

/**
 * Apply a display-attribute patch to the image span located at/around
 * `pos`. Re-locates fresh from `view.state` (AC-C4 — never trusts an
 * offset computed earlier) and no-ops when the view is read-only
 * (AC-C6) or when `pos` no longer resolves to an image. Returns
 * whether a change was dispatched (test convenience).
 */
export function applyImageAttrsPatch(view: EditorView, pos: number, patch: ImageAttrsPatch): boolean {
  if (view.state.readOnly) return false;
  const target = locateImageAttrsTarget(view.state, pos);
  if (!target) return false;

  const merged: ParsedImageAttrs = { ...target.attrs };
  for (const key of Object.keys(patch) as Array<keyof ParsedImageAttrs>) {
    const value = patch[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value as never;
  }

  const body = buildAttrBlockBody(merged, target.unknownTokens);
  if (body === '') {
    if (!target.hasBlock) return false; // nothing to add, nothing to remove.
    view.dispatch({ changes: { from: target.regionFrom, to: target.regionTo, insert: '' } });
    return true;
  }
  if (target.hasBlock) {
    view.dispatch({ changes: { from: target.bodyFrom, to: target.bodyTo, insert: body } });
  } else {
    view.dispatch({ changes: { from: target.imageTo, to: target.imageTo, insert: ` {${body}}` } });
  }
  return true;
}

const ALIGN_OPTIONS = ['left', 'center', 'right'] as const;
const FLOAT_OPTIONS = ['left', 'right'] as const;

/** Append one `align:`/`float:`-style toggle button per option to `group` (shared by the align and float control rows below — identical shape, differing only in label/options/current value/click handler). */
function appendToggleButtons<T extends string>(
  group: HTMLElement,
  label: string,
  options: readonly T[],
  current: T | undefined,
  onToggle: (value: T) => void,
): void {
  for (const value of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-image-affordance-btn';
    btn.textContent = `${label}: ${value}`;
    btn.setAttribute('aria-pressed', String(current === value));
    btn.addEventListener('click', () => onToggle(value));
    group.appendChild(btn);
  }
}

/**
 * Build the tooltip's DOM. `initialAnchor` is a position inside the
 * image span at the moment the tooltip was created; `update()` maps it
 * forward through subsequent document changes (the standard CM6
 * "track a position across edits" idiom — `ChangeSet.mapPos`) so every
 * apply still re-locates from a position that is still inside (or
 * right next to) the same image, even after edits elsewhere in the
 * document shifted absolute offsets.
 */
function buildTooltipView(view: EditorView, initialAnchor: number): TooltipView {
  let anchor = initialAnchor;
  const dom = document.createElement('div');
  dom.className = 'cm-image-affordance';

  function render(): void {
    const target = locateImageAttrsTarget(view.state, anchor);
    dom.replaceChildren();
    if (!target) return;

    const widthInput = document.createElement('input');
    widthInput.type = 'text';
    widthInput.className = 'cm-image-affordance-width';
    widthInput.placeholder = 'width (e.g. 60% / 320px)';
    widthInput.value = target.attrs.width ?? '';
    widthInput.setAttribute('aria-label', 'Image width');
    const commit = () => {
      const raw = widthInput.value.trim();
      applyImageAttrsPatch(view, anchor, { width: raw === '' ? undefined : raw });
    };
    widthInput.addEventListener('change', commit);
    widthInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') widthInput.blur();
    });
    dom.appendChild(widthInput);

    // align/float are standalone-image-only controls (§D10/AC-C5) —
    // block placement / text-wrap has no coherent inline meaning, so
    // they are simply not offered for an inline attributed image.
    if (target.standalone) {
      const group = document.createElement('div');
      group.className = 'cm-image-affordance-group';

      appendToggleButtons(group, 'align', ALIGN_OPTIONS, target.attrs.align, (value) => {
        applyImageAttrsPatch(view, anchor, { align: target.attrs.align === value ? undefined : value });
      });
      appendToggleButtons(group, 'float', FLOAT_OPTIONS, target.attrs.float, (value) => {
        applyImageAttrsPatch(view, anchor, { float: target.attrs.float === value ? undefined : value });
      });
      dom.appendChild(group);
    }
  }

  render();

  return {
    dom,
    update(update) {
      if (update.docChanged) anchor = update.changes.mapPos(anchor, -1, MapMode.TrackDel) ?? anchor;
      if (update.docChanged || update.startState.readOnly !== update.state.readOnly) render();
    },
  };
}

/** Shared source: build a `Tooltip` for the image span at `pos`, or `null` when there isn't one / the editor is read-only (AC-C6 — hides the whole tooltip, the simplest and most testable reading of "hide/disable"). */
function computeTooltip(state: EditorState, pos: number): Tooltip | null {
  if (state.readOnly) return null;
  const target = locateImageAttrsTarget(state, pos);
  if (!target) return null;
  return {
    pos: target.imageFrom,
    end: target.regionTo,
    above: true,
    create: (view) => buildTooltipView(view, target.imageFrom),
  };
}

interface CursorTooltipState {
  tooltip: Tooltip | null;
}

/**
 * Cursor/selection trigger (AC-C1's "focus" half) — shows the same
 * tooltip when the caret sits inside an image span, e.g. after
 * keyboard navigation with no mouse involved at all. Reuses the same
 * `computeTooltip` so hover and focus are visually identical.
 *
 * Keeps the previous `Tooltip` object (by reference) when it still
 * describes the same span, so CodeMirror does not tear down and
 * recreate the `TooltipView` (and thus the DOM the user may be
 * mid-interacting with) on every unrelated transaction.
 *
 * This is the STABLE of the two triggers: it lives as long as the caret
 * stays in the span (a mouse leaving doesn't dismiss it), so when both
 * triggers would fire for one image the hover trigger yields to this one
 * (see `imageHoverTooltipSource`).
 */
const cursorTooltipField = StateField.define<CursorTooltipState>({
  create(state) {
    return { tooltip: computeTooltip(state, state.selection.main.head) };
  },
  update(value, tr) {
    const next = computeTooltip(tr.state, tr.state.selection.main.head);
    if (value.tooltip && next && sameSpan(value.tooltip, next)) {
      return value;
    }
    return { tooltip: next };
  },
  provide: (field) => showTooltip.from(field, (value) => value.tooltip),
});

/** True when two tooltips describe the exact same image span (identical `pos` and `end`). */
function sameSpan(a: Tooltip, b: Tooltip): boolean {
  return a.pos === b.pos && a.end === b.end;
}

/**
 * Mouse-hover trigger source (AC-C1's "hover" half). CodeMirror's
 * built-in `hoverTooltip` owns debounce/positioning/hide-on-mouse-leave;
 * this only decides WHAT to show. It returns the same tooltip as the
 * cursor trigger — EXCEPT it suppresses itself (returns `null`) when the
 * cursor trigger is already showing the affordance for the very same
 * image span, so the two triggers never stack two identical panels over
 * one image (the reported duplicate). Suppression is on the hover side
 * because the cursor tooltip is the stable one; the hover one is the
 * transient one that should yield. Exported for direct unit testing of
 * that suppression.
 */
export function imageHoverTooltipSource(view: EditorView, pos: number): Tooltip | null {
  const hover = computeTooltip(view.state, pos);
  if (!hover) return null;
  const cursor = view.state.field(cursorTooltipField).tooltip;
  if (cursor && sameSpan(cursor, hover)) return null;
  return hover;
}

/**
 * Reverse-order convergence for the path the hover source alone cannot
 * catch: a hover affordance is already open over an image, then the caret
 * enters that SAME span (e.g. the user clicks the image markup), so the
 * cursor trigger produces its own panel. CodeMirror's `hoverTooltip`
 * does not drop itself on a bare selection change, so without this the
 * two panels stack. When the cursor tooltip newly covers a span that an
 * active hover tooltip also covers, close the hover so only the stable
 * cursor panel remains. A DIFFERENT-span hover (caret in image A, mouse
 * over image B) is intentionally left alone (out-of-scope per spec).
 * Dispatched via `queueMicrotask` because an `updateListener` must not
 * dispatch during the in-progress update.
 */
function closeHoverWhenCursorTakesOver(hover: ReturnType<typeof hoverTooltip>): Extension {
  return EditorView.updateListener.of((update) => {
    const prev = update.startState.field(cursorTooltipField).tooltip;
    const next = update.state.field(cursorTooltipField).tooltip;
    if (!next) return;
    if (prev && sameSpan(prev, next)) return; // caret still on the same span — nothing newly appeared.
    const hoverOverlaps = update.state.field(hover.active).some((t) => sameSpan(t, next));
    if (!hoverOverlaps) return;
    queueMicrotask(() => update.view.dispatch({ effects: closeHoverTooltips }));
  });
}

/** Minimal, Crowi-design-token-based styling for the tooltip (same token approach as `autocomplete-extension.ts`'s dropdown theme). */
const affordanceTheme = EditorView.theme({
  '.cm-image-affordance': {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    boxShadow: '0 4px 14px rgb(0 0 0 / 0.12)',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: '12px',
  },
  '.cm-image-affordance-width': {
    border: '1px solid var(--border)',
    borderRadius: 'calc(var(--radius) - 2px)',
    padding: '4px 6px',
    background: 'var(--background)',
    color: 'var(--foreground)',
    fontSize: '12px',
  },
  '.cm-image-affordance-group': {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  '.cm-image-affordance-btn': {
    border: '1px solid var(--border)',
    borderRadius: 'calc(var(--radius) - 2px)',
    padding: '3px 6px',
    background: 'var(--background)',
    color: 'var(--foreground)',
    cursor: 'pointer',
  },
  '.cm-image-affordance-btn[aria-pressed="true"]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
    borderColor: 'var(--accent)',
  },
});

/**
 * The image display-attribute affordance extension. Registered as a
 * built-in in `buildExtensions` (both normal and collaborative editors
 * get it with no new prop — AC-C3).
 */
export function imageAffordanceExtension(): Extension {
  const hover = hoverTooltip(imageHoverTooltipSource, { hoverTime: 300 });
  return [cursorTooltipField, hover, closeHoverWhenCursorTakesOver(hover), affordanceTheme];
}
