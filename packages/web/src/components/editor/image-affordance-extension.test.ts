import { describe, it, expect, afterEach } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorView, activateHover, hasHoverTooltips, showTooltip, type Tooltip } from '@codemirror/view';
import { applyImageAttrsPatch, imageAffordanceExtension, imageHoverTooltipSource, locateImageAttrsTarget } from './image-affordance-extension';

/**
 * RFC-0015 image display attributes — CodeMirror editor affordance
 * (§D13). Tests the pure locate/rewrite logic directly (AC-C2/C4/C5),
 * the focus (cursor-position) tooltip trigger + read-only gating
 * end-to-end via `EditorState`/`showTooltip` (AC-C1/C6), and a light
 * smoke test that the mouse-hover trigger is wired (AC-C1's other
 * half) — the full visual hover/focus UX is exercised manually via
 * crowi-qa per the spec's test plan (DOM-heavy verification deferred).
 */

function markdownState(doc: string, selection?: number): EditorState {
  const state = EditorState.create({ doc, selection: selection !== undefined ? { anchor: selection } : undefined, extensions: [markdown()] });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

describe('locateImageAttrsTarget', () => {
  it('returns null when pos is not inside any image span', () => {
    const state = markdownState('just plain text, no image here');
    expect(locateImageAttrsTarget(state, 5)).toBeNull();
  });

  it('finds an image with no attribute block — standalone (own line, nothing else)', () => {
    const doc = '![alt](x.png)';
    const state = markdownState(doc);
    const target = locateImageAttrsTarget(state, 2);
    expect(target).not.toBeNull();
    expect(target?.hasBlock).toBe(false);
    expect(target?.attrs).toEqual({});
    expect(target?.standalone).toBe(true);
  });

  it('parses an existing attribute block (width/align/float)', () => {
    const doc = '![alt](x.png){width=60% align=center}';
    const state = markdownState(doc);
    const target = locateImageAttrsTarget(state, 2);
    expect(target?.hasBlock).toBe(true);
    expect(target?.attrs).toEqual({ width: '60%', align: 'center' });
    expect(target?.unknownTokens).toEqual([]);
  });

  it('preserves unrecognised tokens (unknown key, malformed) verbatim for round-tripping', () => {
    const doc = '![alt](x.png){foo=bar width=60% garbage}';
    const state = markdownState(doc);
    const target = locateImageAttrsTarget(state, 2);
    expect(target?.attrs).toEqual({ width: '60%' });
    expect(target?.unknownTokens).toEqual(['foo=bar', 'garbage']);
  });

  it('is standalone when the image + block is the only content on its own line, with blank lines around it', () => {
    const doc = 'para one\n\n![alt](x.png){width=60%}\n\npara two';
    const state = markdownState(doc);
    const pos = doc.indexOf('![alt]') + 2;
    expect(locateImageAttrsTarget(state, pos)?.standalone).toBe(true);
  });

  it('is standalone when the attribute block sits on its own next line via a single soft line break (RFC-accepted form, AC-A8/AC-C5)', () => {
    const doc = 'para one\n\n![alt](x.png)\n{width=60%}\n\npara two';
    const state = markdownState(doc);
    const pos = doc.indexOf('![alt]') + 2;
    const target = locateImageAttrsTarget(state, pos);
    expect(target?.hasBlock).toBe(true);
    expect(target?.attrs).toEqual({ width: '60%' });
    expect(target?.standalone).toBe(true);
  });

  it('is NOT standalone when trailing text follows on the same line (AC-A7-equivalent editor heuristic)', () => {
    const doc = '![alt](x.png){width=60%} trailing text';
    const state = markdownState(doc);
    expect(locateImageAttrsTarget(state, 2)?.standalone).toBe(false);
  });

  it('is NOT standalone when a non-blank line directly precedes it in the same paragraph', () => {
    const doc = 'some text right above\n![alt](x.png){width=60%}';
    const state = markdownState(doc);
    const pos = doc.indexOf('![alt]') + 2;
    expect(locateImageAttrsTarget(state, pos)?.standalone).toBe(false);
  });

  it('leaves a huge unterminated block alone and completes quickly (bounded scan, mirrors AC-A10)', () => {
    const huge = `{${'a'.repeat(50_000)}`; // no closing `}`
    const doc = `![alt](x.png)${huge}`;
    const state = markdownState(doc);
    const start = Date.now();
    const target = locateImageAttrsTarget(state, 2);
    expect(Date.now() - start).toBeLessThan(200);
    expect(target?.hasBlock).toBe(false);
  });

  it('ignores a block containing a newline (multi-line blocks are not v1 grammar)', () => {
    const doc = '![alt](x.png){width=60%\nalign=center}';
    const state = markdownState(doc);
    expect(locateImageAttrsTarget(state, 2)?.hasBlock).toBe(false);
  });
});

describe('applyImageAttrsPatch', () => {
  let view: EditorView;
  afterEach(() => view?.destroy());

  function mount(doc: string): EditorView {
    view = new EditorView({ state: markdownState(doc) });
    return view;
  }

  it('adds a new block when none exists (AC-C2)', () => {
    mount('![alt](x.png)');
    const ok = applyImageAttrsPatch(view, 2, { width: '60%' });
    expect(ok).toBe(true);
    expect(view.state.doc.toString()).toBe('![alt](x.png) {width=60%}');
  });

  it('edits an existing block in place, preserving unrecognised tokens (AC-C2)', () => {
    mount('![alt](x.png){foo=bar width=60%}');
    applyImageAttrsPatch(view, 2, { width: '80%', align: 'left' });
    expect(view.state.doc.toString()).toBe('![alt](x.png){width=80% align=left foo=bar}');
  });

  it('removes the whole block once the last recognised attribute and every unknown token are gone', () => {
    mount('![alt](x.png){width=60%}');
    applyImageAttrsPatch(view, 2, { width: undefined });
    expect(view.state.doc.toString()).toBe('![alt](x.png)');
  });

  it('is a no-op when clearing a key that was never set and no block exists', () => {
    mount('![alt](x.png)');
    const ok = applyImageAttrsPatch(view, 2, { align: undefined });
    expect(ok).toBe(false);
    expect(view.state.doc.toString()).toBe('![alt](x.png)');
  });

  it('is a no-op when pos does not resolve to an image', () => {
    mount('plain text only');
    const ok = applyImageAttrsPatch(view, 3, { width: '60%' });
    expect(ok).toBe(false);
    expect(view.state.doc.toString()).toBe('plain text only');
  });

  it('no-ops when the view is read-only (AC-C6)', () => {
    view = new EditorView({ state: EditorState.create({ doc: '![alt](x.png)', extensions: [markdown(), EditorState.readOnly.of(true)] }) });
    ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    const ok = applyImageAttrsPatch(view, 2, { width: '60%' });
    expect(ok).toBe(false);
    expect(view.state.doc.toString()).toBe('![alt](x.png)');
  });

  it('re-locates fresh on every call — two sequential patches compose instead of corrupting on a cached offset (AC-C4)', () => {
    mount('![alt](x.png)');
    const anchor = 2; // inside the image span; stable across our own edits since they only touch text after it.
    expect(applyImageAttrsPatch(view, anchor, { width: '60%' })).toBe(true);
    expect(view.state.doc.toString()).toBe('![alt](x.png) {width=60%}');
    // The second call must recompute the block's (now-shifted) body
    // range from `view.state` again rather than reusing anything
    // cached from the first call — if it didn't, this would either
    // corrupt the document or silently fail.
    expect(applyImageAttrsPatch(view, anchor, { align: 'center' })).toBe(true);
    expect(view.state.doc.toString()).toBe('![alt](x.png) {width=60% align=center}');
  });

  it('re-locates correctly even after an unrelated edit earlier in the document shifted every offset (AC-C4)', () => {
    mount('![alt](x.png){width=60%}');
    const imagePos = 2;
    // Insert text before the image — every absolute offset from here on shifts forward.
    view.dispatch({ changes: { from: 0, to: 0, insert: 'prefix text\n\n' } });
    // The caret/selection based anchor a real caller would use is
    // automatically remapped by CodeMirror; simulate that by using the
    // now-current position of the image rather than the stale raw
    // number — the guarantee under test is that `applyImageAttrsPatch`
    // computes the edit region from `view.state` at call time, not from
    // any value computed before the insert.
    const newImagePos = view.state.doc.toString().indexOf('![alt]') + 2;
    expect(newImagePos).not.toBe(imagePos);
    const ok = applyImageAttrsPatch(view, newImagePos, { align: 'right' });
    expect(ok).toBe(true);
    expect(view.state.doc.toString()).toBe('prefix text\n\n![alt](x.png){width=60% align=right}');
  });
});

/** Read the single non-null tooltip contributed by `imageAffordanceExtension`'s cursor-position field, if any. */
function activeTooltip(state: EditorState): Tooltip | null {
  return state.facet(showTooltip).find((t): t is Tooltip => t !== null) ?? null;
}

describe('cursor (focus) tooltip trigger — showTooltip facet', () => {
  function focusState(doc: string, pos: number, extraExtensions: import('@codemirror/state').Extension[] = []) {
    const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [markdown(), imageAffordanceExtension(), ...extraExtensions] });
    ensureSyntaxTree(state, doc.length, 5_000);
    return state;
  }

  it('shows a tooltip when the cursor sits inside an image span (AC-C1 focus half)', () => {
    const state = focusState('![alt](x.png){width=60%}', 2);
    expect(activeTooltip(state)).not.toBeNull();
  });

  it('shows no tooltip when the cursor sits outside any image span', () => {
    const state = focusState('plain text ![alt](x.png){width=60%} more text', 0);
    expect(activeTooltip(state)).toBeNull();
  });

  it('renders a width input pre-filled with the current value, plus align/float controls, for a standalone image (AC-C1, AC-C5)', () => {
    const doc = '![alt](x.png){width=60% align=center}';
    const state = focusState(doc, 2);
    const tooltip = activeTooltip(state)!;
    const view = new EditorView({ state });
    const tooltipView = tooltip.create(view);
    const widthInput = tooltipView.dom.querySelector('input') as HTMLInputElement;
    expect(widthInput.value).toBe('60%');
    const buttons = Array.from(tooltipView.dom.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['align: left', 'align: center', 'align: right', 'float: left', 'float: right']);
    const centerBtn = tooltipView.dom.querySelector('button[aria-pressed="true"]');
    expect(centerBtn?.textContent).toBe('align: center');
    view.destroy();
  });

  it('still shows align/float controls when the attribute block is on its own soft-break line (RFC-accepted standalone form, AC-C5 regression)', () => {
    const doc = '![alt](x.png)\n{width=60% align=center}';
    const state = focusState(doc, 2);
    const tooltip = activeTooltip(state)!;
    const view = new EditorView({ state });
    const tooltipView = tooltip.create(view);
    const buttons = Array.from(tooltipView.dom.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['align: left', 'align: center', 'align: right', 'float: left', 'float: right']);
    view.destroy();
  });

  it('omits align/float controls for an inline (non-standalone) attributed image (AC-C5)', () => {
    const doc = '![alt](x.png){width=60%} trailing text';
    const state = focusState(doc, 2);
    const tooltip = activeTooltip(state)!;
    const view = new EditorView({ state });
    const tooltipView = tooltip.create(view);
    expect(tooltipView.dom.querySelectorAll('button')).toHaveLength(0);
    expect((tooltipView.dom.querySelector('input') as HTMLInputElement).value).toBe('60%');
    view.destroy();
  });

  it('clicking an align button dispatches the corresponding source rewrite (AC-C2)', () => {
    const doc = '![alt](x.png)';
    const state = focusState(doc, 2);
    const tooltip = activeTooltip(state)!;
    const view = new EditorView({ state });
    const tooltipView = tooltip.create(view);
    const rightBtn = Array.from(tooltipView.dom.querySelectorAll('button')).find((b) => b.textContent === 'align: right')!;
    rightBtn.click();
    expect(view.state.doc.toString()).toBe('![alt](x.png) {align=right}');
    view.destroy();
  });

  it('hides the tooltip when the editor is read-only from the start (AC-C6)', () => {
    const state = focusState('![alt](x.png){width=60%}', 2, [EditorState.readOnly.of(true)]);
    expect(activeTooltip(state)).toBeNull();
  });

  it('hides the tooltip after a mid-session read-only flip (AC-C6 — same view.state.readOnly source as drop-handler)', () => {
    const readonlyCompartment = new Compartment();
    let state = EditorState.create({
      doc: '![alt](x.png){width=60%}',
      selection: { anchor: 2 },
      extensions: [markdown(), imageAffordanceExtension(), readonlyCompartment.of([])],
    });
    ensureSyntaxTree(state, state.doc.length, 5_000);
    expect(activeTooltip(state)).not.toBeNull();

    const tr = state.update({ effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(true)) });
    state = tr.state;
    expect(activeTooltip(state)).toBeNull();
  });
});

describe('mouse-hover trigger wiring (AC-C1 hover half — smoke test; full UX left to crowi-qa)', () => {
  let view: EditorView;
  afterEach(() => view?.destroy());

  it('activates a tooltip at an image position and none at a non-image position', () => {
    const doc = 'plain text ![alt](x.png){width=60%} more text';
    view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), imageAffordanceExtension()] }) });
    ensureSyntaxTree(view.state, doc.length, 5_000);

    activateHover(view, doc.indexOf('![alt]') + 2, 1);
    expect(hasHoverTooltips(view.state)).toBe(true);
  });

  it('does not activate when the editor is read-only', () => {
    const doc = '![alt](x.png){width=60%}';
    view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), imageAffordanceExtension(), EditorState.readOnly.of(true)] }) });
    ensureSyntaxTree(view.state, doc.length, 5_000);

    activateHover(view, 2, 1);
    expect(hasHoverTooltips(view.state)).toBe(false);
  });
});

/**
 * Duplicate-panel fix: the hover trigger and the cursor trigger both
 * build a (visually identical) affordance and CodeMirror does not
 * de-duplicate across the two `showTooltip` sources, so a caret sitting
 * inside the same image markup the mouse is over used to stack two
 * panels. The hover trigger yields to the (stable) cursor trigger on the
 * same span; a hover for a DIFFERENT image is left alone.
 */
describe('duplicate-panel suppression — hover yields to the cursor trigger on the same span', () => {
  function noParentState(doc: string, caret: number): EditorState {
    const state = EditorState.create({ doc, selection: { anchor: caret }, extensions: [markdown(), imageAffordanceExtension()] });
    ensureSyntaxTree(state, doc.length, 5_000);
    return state;
  }

  describe('hover source function (direct)', () => {
    let view: EditorView;
    afterEach(() => view?.destroy());

    it('returns null when the cursor trigger already shows the affordance for the SAME span', () => {
      const doc = '![alt](x.png){width=60%}';
      view = new EditorView({ state: noParentState(doc, 2) }); // caret inside the span
      expect(imageHoverTooltipSource(view, 2)).toBeNull();
    });

    it('returns a tooltip when the caret is OUTSIDE the span (hover-only case — no regression)', () => {
      const doc = 'plain ![alt](x.png){width=60%} text';
      const imgPos = doc.indexOf('![alt]') + 2;
      view = new EditorView({ state: noParentState(doc, 0) }); // caret outside any image
      expect(imageHoverTooltipSource(view, imgPos)).not.toBeNull();
    });

    it('returns a tooltip for image B even while the cursor trigger shows image A (different spans are not suppressed)', () => {
      const doc = '![a](a.png)\n\n![b](b.png)';
      const posA = doc.indexOf('![a]') + 2;
      const posB = doc.indexOf('![b]') + 2;
      view = new EditorView({ state: noParentState(doc, posA) }); // caret in image A
      expect(imageHoverTooltipSource(view, posB)).not.toBeNull();
    });
  });

  describe('rendered panel count (real EditorView mounted in the document)', () => {
    let view: EditorView;
    let host: HTMLElement;

    afterEach(() => {
      view?.destroy();
      host?.remove();
    });

    /** Tooltips render on CodeMirror's rAF-scheduled measure + our reverse-order `queueMicrotask` — give both a few macrotask turns to settle. */
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
    const panelCount = () => document.querySelectorAll('.cm-image-affordance').length;

    function mount(doc: string, caret: number): EditorView {
      host = document.createElement('div');
      document.body.appendChild(host);
      view = new EditorView({
        state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [markdown(), imageAffordanceExtension()] }),
        parent: host,
      });
      ensureSyntaxTree(view.state, doc.length, 5_000);
      return view;
    }

    it('shows exactly one panel when the caret is in the span AND the mouse hovers the same span', async () => {
      mount('![alt](x.png){width=60%}', 2);
      await settle();
      expect(panelCount()).toBe(1); // cursor trigger's panel

      activateHover(view, 2, 1); // hover the same span
      await settle();
      expect(hasHoverTooltips(view.state)).toBe(false); // hover suppressed itself
      expect(panelCount()).toBe(1); // still just one
    });

    it('converges to one panel in the reverse order — hover first, then the caret enters the same span', async () => {
      mount('plain ![alt](x.png){width=60%} text', 0); // caret outside
      const imgPos = view.state.doc.toString().indexOf('![alt]') + 2;

      activateHover(view, imgPos, 1); // mouse hovers the image, caret still outside
      await settle();
      expect(hasHoverTooltips(view.state)).toBe(true);
      expect(panelCount()).toBe(1); // hover panel

      view.dispatch({ selection: { anchor: imgPos } }); // click into the markup → cursor trigger fires too
      await settle();
      expect(hasHoverTooltips(view.state)).toBe(false); // the reverse-order listener closed the hover
      expect(panelCount()).toBe(1); // converged, not stacked
    });

    it('keeps two panels for two DIFFERENT images — caret in A, mouse over B (out-of-scope of the fix)', async () => {
      mount('![a](a.png)\n\n![b](b.png)', 2); // caret in image A
      await settle();
      expect(panelCount()).toBe(1); // A's cursor panel

      const posB = view.state.doc.toString().indexOf('![b]') + 2;
      activateHover(view, posB, 1); // hover image B
      await settle();
      expect(hasHoverTooltips(view.state)).toBe(true);
      expect(panelCount()).toBe(2); // one per image — not suppressed
    });
  });
});
