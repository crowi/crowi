import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { overwriteGetLocale } from '@paraglide/runtime.js';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorView, activateHover, hasHoverTooltips, showTooltip, type Tooltip } from '@codemirror/view';
import { applyLinkCardConversion, linkCardAffordanceExtension, linkCardHoverTooltipSource, locateLinkCardTarget } from './link-card-affordance-extension';

// The button label is locale-driven (`messages/{ja,en}.json`); pin to `en`
// so assertions on the exact text are deterministic regardless of the
// project's `baseLocale` (`ja` — `project.inlang/settings.json`).
beforeEach(() => {
  overwriteGetLocale(() => 'en');
});

/**
 * Editor affordance for the bare URL <-> `@[card](url)` conversion
 * (spec §"editor affordance(web 側)"). Structured like
 * `image-affordance-extension.test.ts`: pure locate/convert logic
 * first, then the cursor (focus) trigger via the `showTooltip` facet,
 * then the hover trigger + duplicate-panel suppression.
 */

function markdownState(doc: string, selection?: number): EditorState {
  const state = EditorState.create({ doc, selection: selection !== undefined ? { anchor: selection } : undefined, extensions: [markdown()] });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

describe('locateLinkCardTarget', () => {
  it('returns null for plain prose with no URL', () => {
    const state = markdownState('just plain text, nothing to see here');
    expect(locateLinkCardTarget(state, 5)).toBeNull();
  });

  it('finds a bare http(s) URL', () => {
    const doc = 'See https://example.com/page here.';
    const state = markdownState(doc);
    const pos = doc.indexOf('https://') + 3;
    const target = locateLinkCardTarget(state, pos);
    expect(target).toEqual({ kind: 'bare-url', from: doc.indexOf('https://'), to: doc.indexOf(' here'), url: 'https://example.com/page' });
  });

  it('trims trailing sentence punctuation off a bare URL', () => {
    const doc = 'Visit https://example.com/page.';
    const state = markdownState(doc);
    const pos = doc.indexOf('https://') + 3;
    const target = locateLinkCardTarget(state, pos);
    expect(target?.url).toBe('https://example.com/page');
    expect(doc.slice(target!.to, target!.to + 1)).toBe('.');
  });

  it('does NOT fire for [label](url) — an authored label is respected', () => {
    const doc = 'See [my label](https://example.com/page) here.';
    const state = markdownState(doc);
    // Cursor inside the label.
    expect(locateLinkCardTarget(state, doc.indexOf('my label') + 2)).toBeNull();
    // Cursor inside the URL portion.
    expect(locateLinkCardTarget(state, doc.indexOf('https://') + 3)).toBeNull();
  });

  it('does NOT fire for an unrelated @[tag](url) whose label is not "card"', () => {
    const doc = '@[echo](https://example.com/page)';
    const state = markdownState(doc);
    expect(locateLinkCardTarget(state, doc.indexOf('echo') + 1)).toBeNull();
  });

  it('does NOT fire for a plain [card](url) link missing the leading @', () => {
    const doc = 'See [card](https://example.com/page) here.';
    const state = markdownState(doc);
    expect(locateLinkCardTarget(state, doc.indexOf('card') + 1)).toBeNull();
  });

  it('finds @[card](url) and offers to revert to a bare URL, covering both the "@[card]" label and the url', () => {
    const doc = 'See @[card](https://example.com/page) here.';
    const state = markdownState(doc);
    const atIndex = doc.indexOf('@[card]');
    const target = locateLinkCardTarget(state, atIndex + 3);
    expect(target).toEqual({ kind: 'card-tag', from: atIndex, to: doc.indexOf(') here') + 1, url: 'https://example.com/page' });
  });

  it('finds @[card](url) when it opens the document (no preceding text)', () => {
    const doc = '@[card](https://example.com/page)';
    const state = markdownState(doc);
    const target = locateLinkCardTarget(state, 3);
    expect(target).toEqual({ kind: 'card-tag', from: 0, to: doc.length, url: 'https://example.com/page' });
  });

  it('does not treat a bare URL inside a fenced code block as convertible', () => {
    const doc = ['```', 'https://example.com/page', '```'].join('\n');
    const state = markdownState(doc);
    const pos = doc.indexOf('https://') + 3;
    expect(locateLinkCardTarget(state, pos)).toBeNull();
  });

  it('does not treat a bare URL inside inline code as convertible', () => {
    const doc = 'See `https://example.com/page` here.';
    const state = markdownState(doc);
    const pos = doc.indexOf('https://') + 3;
    expect(locateLinkCardTarget(state, pos)).toBeNull();
  });
});

describe('applyLinkCardConversion', () => {
  let view: EditorView;
  afterEach(() => view?.destroy());

  function mount(doc: string): EditorView {
    view = new EditorView({ state: markdownState(doc) });
    return view;
  }

  it('converts a bare URL to @[card](url) in place', () => {
    const doc = 'See https://example.com/page here.';
    mount(doc);
    const pos = doc.indexOf('https://') + 3;
    expect(applyLinkCardConversion(view, pos)).toBe(true);
    expect(view.state.doc.toString()).toBe('See @[card](https://example.com/page) here.');
  });

  it('converts @[card](url) back to a bare URL', () => {
    const doc = 'See @[card](https://example.com/page) here.';
    mount(doc);
    const pos = doc.indexOf('@[card]') + 3;
    expect(applyLinkCardConversion(view, pos)).toBe(true);
    expect(view.state.doc.toString()).toBe('See https://example.com/page here.');
  });

  it('round-trips: bare URL -> card -> bare URL restores the original document', () => {
    const original = 'See https://example.com/page here.';
    mount(original);
    const urlPos = original.indexOf('https://') + 3;
    applyLinkCardConversion(view, urlPos);
    const afterToCard = view.state.doc.toString();
    expect(afterToCard).toBe('See @[card](https://example.com/page) here.');
    const cardPos = afterToCard.indexOf('@[card]') + 3;
    applyLinkCardConversion(view, cardPos);
    expect(view.state.doc.toString()).toBe(original);
  });

  it('is a no-op when pos does not resolve to any target', () => {
    mount('plain text only');
    expect(applyLinkCardConversion(view, 3)).toBe(false);
    expect(view.state.doc.toString()).toBe('plain text only');
  });

  it('is a no-op for [label](url) — never discards an authored label', () => {
    const doc = 'See [my label](https://example.com/page) here.';
    mount(doc);
    expect(applyLinkCardConversion(view, doc.indexOf('my label') + 2)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('no-ops when the view is read-only', () => {
    const doc = 'See https://example.com/page here.';
    view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), EditorState.readOnly.of(true)] }) });
    ensureSyntaxTree(view.state, doc.length, 5_000);
    const pos = doc.indexOf('https://') + 3;
    expect(applyLinkCardConversion(view, pos)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

/** Read the single non-null tooltip contributed by `linkCardAffordanceExtension`'s cursor-position field, if any. */
function activeTooltip(state: EditorState): Tooltip | null {
  return state.facet(showTooltip).find((t): t is Tooltip => t !== null) ?? null;
}

describe('cursor (focus) tooltip trigger — showTooltip facet', () => {
  function focusState(doc: string, pos: number): EditorState {
    const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [markdown(), linkCardAffordanceExtension()] });
    ensureSyntaxTree(state, doc.length, 5_000);
    return state;
  }

  it('shows a tooltip when the cursor sits inside a bare URL', () => {
    const doc = 'See https://example.com/page here.';
    const state = focusState(doc, doc.indexOf('https://') + 3);
    expect(activeTooltip(state)).not.toBeNull();
  });

  it('shows a tooltip when the cursor sits inside @[card](url)', () => {
    const doc = 'See @[card](https://example.com/page) here.';
    const state = focusState(doc, doc.indexOf('@[card]') + 3);
    expect(activeTooltip(state)).not.toBeNull();
  });

  it('shows no tooltip for [label](url)', () => {
    const doc = 'See [my label](https://example.com/page) here.';
    const state = focusState(doc, doc.indexOf('my label') + 2);
    expect(activeTooltip(state)).toBeNull();
  });

  it('shows no tooltip outside any target', () => {
    const state = focusState('plain text, nothing here', 3);
    expect(activeTooltip(state)).toBeNull();
  });

  it('renders a "Convert to card" button for a bare URL', () => {
    const doc = 'See https://example.com/page here.';
    const state = focusState(doc, doc.indexOf('https://') + 3);
    const tooltip = activeTooltip(state)!;
    const view = new EditorView({ state });
    const tooltipView = tooltip.create(view);
    const btn = tooltipView.dom.querySelector('button')!;
    expect(btn.textContent).toBe('Convert to card');
    view.destroy();
  });

  it('renders a "Convert to link" button for @[card](url)', () => {
    const doc = 'See @[card](https://example.com/page) here.';
    const state = focusState(doc, doc.indexOf('@[card]') + 3);
    const tooltip = activeTooltip(state)!;
    const view = new EditorView({ state });
    const tooltipView = tooltip.create(view);
    const btn = tooltipView.dom.querySelector('button')!;
    expect(btn.textContent).toBe('Convert to link');
    view.destroy();
  });

  it('clicking the button dispatches the conversion (AC: affordance actually converts)', () => {
    const doc = 'See https://example.com/page here.';
    const state = focusState(doc, doc.indexOf('https://') + 3);
    const tooltip = activeTooltip(state)!;
    const view = new EditorView({ state });
    const tooltipView = tooltip.create(view);
    tooltipView.dom.querySelector('button')!.click();
    expect(view.state.doc.toString()).toBe('See @[card](https://example.com/page) here.');
    view.destroy();
  });

  it('hides the tooltip when the editor is read-only from the start', () => {
    const doc = 'See https://example.com/page here.';
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('https://') + 3 },
      extensions: [markdown(), linkCardAffordanceExtension(), EditorState.readOnly.of(true)],
    });
    ensureSyntaxTree(state, doc.length, 5_000);
    expect(activeTooltip(state)).toBeNull();
  });
});

describe('mouse-hover trigger wiring (smoke test; full UX left to crowi-qa)', () => {
  let view: EditorView;
  afterEach(() => view?.destroy());

  it('activates a tooltip at a bare-URL position and none at a plain-text position', () => {
    const doc = 'plain text https://example.com/page more text';
    view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), linkCardAffordanceExtension()] }) });
    ensureSyntaxTree(view.state, doc.length, 5_000);

    activateHover(view, doc.indexOf('https://') + 3, 1);
    expect(hasHoverTooltips(view.state)).toBe(true);
  });

  it('does not activate for [label](url)', () => {
    const doc = 'See [my label](https://example.com/page) here.';
    view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), linkCardAffordanceExtension()] }) });
    ensureSyntaxTree(view.state, doc.length, 5_000);

    activateHover(view, doc.indexOf('my label') + 2, 1);
    expect(hasHoverTooltips(view.state)).toBe(false);
  });

  it('does not activate when the editor is read-only', () => {
    const doc = 'https://example.com/page';
    view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), linkCardAffordanceExtension(), EditorState.readOnly.of(true)] }) });
    ensureSyntaxTree(view.state, doc.length, 5_000);

    activateHover(view, 3, 1);
    expect(hasHoverTooltips(view.state)).toBe(false);
  });
});

/**
 * Duplicate-panel fix, same technique as `image-affordance-extension.ts`:
 * the hover trigger yields to the (stable) cursor trigger on the same
 * span so a caret sitting inside the same URL the mouse is over
 * doesn't stack two panels.
 */
describe('duplicate-panel suppression — hover yields to the cursor trigger on the same span', () => {
  function noParentState(doc: string, caret: number): EditorState {
    const state = EditorState.create({ doc, selection: { anchor: caret }, extensions: [markdown(), linkCardAffordanceExtension()] });
    ensureSyntaxTree(state, doc.length, 5_000);
    return state;
  }

  describe('hover source function (direct)', () => {
    let view: EditorView;
    afterEach(() => view?.destroy());

    it('returns null when the cursor trigger already shows the affordance for the SAME span', () => {
      const doc = 'https://example.com/page';
      view = new EditorView({ state: noParentState(doc, 3) }); // caret inside the URL
      expect(linkCardHoverTooltipSource(view, 3)).toBeNull();
    });

    it('returns a tooltip when the caret is OUTSIDE the span (hover-only case — no regression)', () => {
      const doc = 'plain https://example.com/page text';
      const urlPos = doc.indexOf('https://') + 3;
      view = new EditorView({ state: noParentState(doc, 0) }); // caret outside the URL
      expect(linkCardHoverTooltipSource(view, urlPos)).not.toBeNull();
    });

    it('returns a tooltip for URL B even while the cursor trigger shows URL A (different spans are not suppressed)', () => {
      const doc = 'https://a.example.com\n\nhttps://b.example.com';
      const posA = 3;
      const posB = doc.indexOf('https://b') + 3;
      view = new EditorView({ state: noParentState(doc, posA) });
      expect(linkCardHoverTooltipSource(view, posB)).not.toBeNull();
    });
  });

  describe('rendered panel count (real EditorView mounted in the document)', () => {
    let view: EditorView;
    let host: HTMLElement;

    afterEach(() => {
      view?.destroy();
      host?.remove();
    });

    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
    const panelCount = () => document.querySelectorAll('.cm-link-card-affordance').length;

    function mount(doc: string, caret: number): EditorView {
      host = document.createElement('div');
      document.body.appendChild(host);
      view = new EditorView({
        state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [markdown(), linkCardAffordanceExtension()] }),
        parent: host,
      });
      ensureSyntaxTree(view.state, doc.length, 5_000);
      return view;
    }

    it('shows exactly one panel when the caret is in the URL AND the mouse hovers the same span', async () => {
      mount('https://example.com/page', 3);
      await settle();
      expect(panelCount()).toBe(1); // cursor trigger's panel

      activateHover(view, 3, 1); // hover the same span
      await settle();
      expect(hasHoverTooltips(view.state)).toBe(false); // hover suppressed itself
      expect(panelCount()).toBe(1); // still just one
    });

    it('converges to one panel in the reverse order — hover first, then the caret enters the same span', async () => {
      mount('plain https://example.com/page text', 0); // caret outside
      const urlPos = view.state.doc.toString().indexOf('https://') + 3;

      activateHover(view, urlPos, 1); // mouse hovers the URL, caret still outside
      await settle();
      expect(hasHoverTooltips(view.state)).toBe(true);
      expect(panelCount()).toBe(1); // hover panel

      view.dispatch({ selection: { anchor: urlPos } }); // caret enters the same span
      await settle();
      expect(hasHoverTooltips(view.state)).toBe(false); // the reverse-order listener closed the hover
      expect(panelCount()).toBe(1); // converged, not stacked
    });
  });
});
