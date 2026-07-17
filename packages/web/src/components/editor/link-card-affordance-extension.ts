import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, MapMode, StateField } from '@codemirror/state';
import { closeHoverTooltips, EditorView, hoverTooltip, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import { m } from '@paraglide/messages.js';
import { isSuppressedContext } from './autocomplete-extension';

/**
 * Link-card editor affordance — a hover/focus tooltip that lets the
 * author convert a bare `http(s)://` URL to `@[card](url)` (the OGP
 * link-card embed tag — `@crowi/plugin-renderer-link-card`) and back.
 * Modelled directly on `image-affordance-extension.ts`'s CodeMirror
 * hover/cursor tooltip pattern (`cursorTooltipField` + `hoverTooltip`,
 * the same same-span dedup technique from the duplicate-tooltip-fix,
 * `MapMode.TrackDel` position tracking, `buildTooltipView`).
 *
 * Deliberately does NOT offer this affordance for `[label](url)` —
 * an author who chose a label is trusted; converting would either
 * discard it or produce a confusing `@[card]` that ignores it (spec
 * §"editor affordance(web 側)", consistent with `url-inline-expand.ts`'s
 * design stance of leaving an authored label alone).
 *
 * `@lezer/markdown`'s GFM `Autolink` extension is NOT enabled on this
 * editor's `markdown()` config (`build-extensions.ts`), so a bare URL
 * has no dedicated syntax-tree node the way `paste-handler.ts`'s
 * clipboard-URL detection also does not rely on one. Bare-URL
 * detection here is therefore a bounded regex scan of the current
 * line (mirroring `paste-handler.ts:extractSingleUrl`'s http(s)-only,
 * no-embedded-whitespace rule) rather than a syntax-tree lookup — see
 * `findBareUrlAt`. `@[card](url)` / `[label](url)` detection, in
 * contrast, DOES use the syntax tree (the `Link` node CommonMark
 * already parses without any GFM extension) — see `findCardTagAt`.
 */

const CARD_TAG_LABEL = 'card';

/** Same http(s)-only URL shape `paste-handler.ts:extractSingleUrl` accepts, scanned inline rather than requiring the whole clipboard/line to be just the URL. Excludes whitespace, angle brackets, and square/round brackets so a match never bleeds into an adjacent `[…](…)` construct. */
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]]+/g;
/** Trailing sentence punctuation trimmed off a bare-URL match, so "visit https://x.com." doesn't fold the sentence's period into the URL. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?'")\]]+$/;

export interface LinkCardTarget {
  kind: 'bare-url' | 'card-tag';
  /** Start of the replace-region (for `card-tag`, includes the leading `@`). */
  from: number;
  /** End of the replace-region (exclusive). */
  to: number;
  /** The bare URL, without any surrounding markup. */
  url: string;
}

/** Locate a bare `http(s)://…` run at/around `pos` on its current line, or `null`. `isSuppressedContext` (`autocomplete-extension.ts`) is reused as the single source of truth for "not plain prose" (code/math/existing `Link`/`Image`/`URL`) so a bare-URL scan never fires inside those — same predicate the autocomplete dropdown already uses to gate itself. */
function findBareUrlAt(state: EditorState, pos: number): LinkCardTarget | null {
  const line = state.doc.lineAt(pos);
  BARE_URL_RE.lastIndex = 0;
  let match = BARE_URL_RE.exec(line.text);
  while (match) {
    const rawFrom = line.from + match.index;
    let rawTo = rawFrom + match[0].length;
    let url = match[0];
    const trailing = TRAILING_PUNCTUATION_RE.exec(url);
    if (trailing) {
      url = url.slice(0, url.length - trailing[0].length);
      rawTo -= trailing[0].length;
    }
    if (url.length > 0 && pos >= rawFrom && pos <= rawTo && !isSuppressedContext(state, rawFrom)) {
      return { kind: 'bare-url', from: rawFrom, to: rawTo, url };
    }
    match = BARE_URL_RE.exec(line.text);
  }
  return null;
}

/**
 * Locate an `@[card](url)` construct at/around `pos`, via the `Link`
 * syntax node CommonMark already produces (no GFM extension needed).
 * Mirrors the api-side `embed-tags.ts:collectCandidates` rule exactly:
 * the character immediately before the `Link` node must be `@`, and
 * the `Link`'s only children must be its 4 `LinkMark`s + the `URL` —
 * no nested formatting in the label (that mirrors
 * `link.children.length === 1 && type === 'text'` on the mdast side).
 * The label text itself must equal `"card"` (this extension is
 * card-tag-specific, not a general `@[tag]` detector).
 */
function findCardTagAt(state: EditorState, pos: number): LinkCardTarget | null {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.name !== 'Link') {
    if (!node.parent) return null;
    node = node.parent;
  }
  if (!node || node.from === 0) return null;

  const doc = state.doc;
  if (doc.sliceString(node.from - 1, node.from) !== '@') return null;

  const children: { name: string; from: number; to: number }[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push({ name: child.name, from: child.from, to: child.to });
  }
  if (children.length !== 5) return null;
  const linkMarks = children.filter((c) => c.name === 'LinkMark');
  const urlChild = children.find((c) => c.name === 'URL');
  if (linkMarks.length !== 4 || !urlChild) return null;

  const [openBracket, closeBracket] = linkMarks; // document order: `[`, `]`, `(`, `)`
  const label = doc.sliceString(openBracket.to, closeBracket.from);
  if (label !== CARD_TAG_LABEL) return null;

  return { kind: 'card-tag', from: node.from - 1, to: node.to, url: doc.sliceString(urlChild.from, urlChild.to) };
}

/** `@[card](url)` takes priority (it's the more specific match — a bare-URL scan would otherwise also match its `URL` child, but `isSuppressedContext` already excludes that span). */
export function locateLinkCardTarget(state: EditorState, pos: number): LinkCardTarget | null {
  return findCardTagAt(state, pos) ?? findBareUrlAt(state, pos);
}

/**
 * Apply the conversion for the target located at/around `pos`,
 * re-locating fresh from `view.state` (never trusting an offset
 * computed earlier — same discipline as
 * `image-affordance-extension.ts:applyImageAttrsPatch`). No-op when
 * the view is read-only or `pos` no longer resolves to a target.
 * Returns whether a change was dispatched (test convenience).
 */
export function applyLinkCardConversion(view: EditorView, pos: number): boolean {
  if (view.state.readOnly) return false;
  const target = locateLinkCardTarget(view.state, pos);
  if (!target) return false;
  const insert = target.kind === 'bare-url' ? `@[card](${target.url})` : target.url;
  view.dispatch({ changes: { from: target.from, to: target.to, insert } });
  return true;
}

/** Build the tooltip's DOM — a single button whose label/action depends on which direction the conversion goes. */
function buildTooltipView(view: EditorView, initialAnchor: number): TooltipView {
  let anchor = initialAnchor;
  const dom = document.createElement('div');
  dom.className = 'cm-link-card-affordance';

  function render(): void {
    const target = locateLinkCardTarget(view.state, anchor);
    dom.replaceChildren();
    if (!target) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-link-card-affordance-btn';
    btn.textContent = target.kind === 'bare-url' ? m['edit.link_card_convert_to_card']() : m['edit.link_card_revert_to_link']();
    btn.addEventListener('click', () => {
      applyLinkCardConversion(view, anchor);
    });
    dom.appendChild(btn);
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

/**
 * Shared source: build a `Tooltip` for the target at `pos`, or `null`
 * when there isn't one / the editor is read-only. The `TooltipView`'s
 * re-locate anchor is the trigger `pos` itself — NOT `target.from` —
 * because for a `card-tag` target `target.from` is `link.from - 1`
 * (the `@`, one position before the `Link` node even starts), which
 * `locateLinkCardTarget` cannot resolve back into that `Link` node (the
 * boundary sits on the wrong side). `pos` is, by construction, always a
 * position `locateLinkCardTarget` already resolved successfully once,
 * so re-querying at the same `pos` is self-consistent for both target
 * kinds.
 */
function computeTooltip(state: EditorState, pos: number): Tooltip | null {
  if (state.readOnly) return null;
  const target = locateLinkCardTarget(state, pos);
  if (!target) return null;
  return {
    pos: target.from,
    end: target.to,
    above: true,
    create: (view) => buildTooltipView(view, pos),
  };
}

interface CursorTooltipState {
  tooltip: Tooltip | null;
}

/** Cursor/selection trigger — shows the affordance when the caret sits inside a bare URL or `@[card](url)`, e.g. after keyboard navigation. Reference-stable across transactions that don't change which span is targeted, so CodeMirror doesn't tear down and rebuild the `TooltipView` on every unrelated edit. */
const linkCardCursorTooltipField = StateField.define<CursorTooltipState>({
  create(state) {
    return { tooltip: computeTooltip(state, state.selection.main.head) };
  },
  update(value, tr) {
    const next = computeTooltip(tr.state, tr.state.selection.main.head);
    if (value.tooltip && next && sameSpan(value.tooltip, next)) return value;
    return { tooltip: next };
  },
  provide: (field) => showTooltip.from(field, (value) => value.tooltip),
});

function sameSpan(a: Tooltip, b: Tooltip): boolean {
  return a.pos === b.pos && a.end === b.end;
}

/**
 * Mouse-hover trigger. Suppresses itself when the cursor trigger is
 * already showing the affordance for the exact same span, so the two
 * triggers never stack two panels over one target (duplicate-tooltip-
 * fix technique, same as `image-affordance-extension.ts`'s
 * `imageHoverTooltipSource`). Exported for direct unit testing of that
 * suppression.
 */
export function linkCardHoverTooltipSource(view: EditorView, pos: number): Tooltip | null {
  const hover = computeTooltip(view.state, pos);
  if (!hover) return null;
  const cursor = view.state.field(linkCardCursorTooltipField).tooltip;
  if (cursor && sameSpan(cursor, hover)) return null;
  return hover;
}

/** Reverse-order convergence: close an open hover panel when the cursor trigger newly covers the exact same span (e.g. the user clicks into a hovered URL). See `image-affordance-extension.ts:closeHoverWhenCursorTakesOver` for the full rationale — identical technique, scoped to this extension's own state field. */
function closeHoverWhenCursorTakesOver(hover: ReturnType<typeof hoverTooltip>): Extension {
  return EditorView.updateListener.of((update) => {
    const prev = update.startState.field(linkCardCursorTooltipField).tooltip;
    const next = update.state.field(linkCardCursorTooltipField).tooltip;
    if (!next) return;
    if (prev && sameSpan(prev, next)) return;
    const hoverOverlaps = update.state.field(hover.active).some((t) => sameSpan(t, next));
    if (!hoverOverlaps) return;
    queueMicrotask(() => update.view.dispatch({ effects: closeHoverTooltips }));
  });
}

/** Crowi-design-token-based styling, matching `image-affordance-extension.ts`'s `affordanceTheme` approach. */
const linkCardAffordanceTheme = EditorView.theme({
  '.cm-link-card-affordance': {
    display: 'flex',
    padding: '2px',
  },
  '.cm-link-card-affordance-btn': {
    border: '1px solid var(--border)',
    borderRadius: 'calc(var(--radius) - 2px)',
    padding: '4px 8px',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: '12px',
    cursor: 'pointer',
    boxShadow: '0 4px 14px rgb(0 0 0 / 0.12)',
  },
});

/**
 * The link-card conversion affordance extension. Registered as a
 * built-in in `buildExtensions` — always on, no opt-out prop, reading
 * `EditorState.readOnly` itself (same pattern as
 * `imageAffordanceExtension()`).
 */
export function linkCardAffordanceExtension(): Extension {
  const hover = hoverTooltip(linkCardHoverTooltipSource, { hoverTime: 300 });
  return [linkCardCursorTooltipField, hover, closeHoverWhenCursorTakesOver(hover), linkCardAffordanceTheme];
}
