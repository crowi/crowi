import { EditorSelection, EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorView, runScopeHandlers, showTooltip } from '@codemirror/view';
import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from './build-extensions';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';

afterEach(() => cleanup());

/**
 * Helper: assemble an EditorState with the same extensions the
 * component would, so we can poke at the configured behaviour
 * without mounting an EditorView. The Markdown / theme / history
 * extensions all live in the same closure, so we can verify
 * readOnly / extraExtensions wiring through the resulting state.
 */
function makeState(opts: Parameters<typeof buildExtensions>[0]) {
  return EditorState.create({ doc: '', extensions: buildExtensions(opts) });
}

describe('buildExtensions', () => {
  it('returns a configurable extension array (mounts cleanly as EditorState)', () => {
    const state = makeState({});
    // readOnly is the easiest published facet — facet value defaults
    // to false when no `EditorState.readOnly.of(true)` is added.
    expect(state.readOnly).toBe(false);
  });

  it('threads readonly through to EditorState.readOnly facet', () => {
    const state = makeState({ readonly: true });
    expect(state.readOnly).toBe(true);
  });

  it('accepts extraExtensions and includes them in the resolved extension graph', () => {
    // Add a custom facet via an extension. The actual API we care
    // about is "the function does not throw and the returned state
    // includes our extension"; we verify via state.facet.
    const customFacet = EditorState.readOnly.of(true); // already covered above, but exercises the pass-through path
    const state = makeState({ extraExtensions: [customFacet] });
    expect(state.readOnly).toBe(true);
  });

  it('wires onChange via an EditorView.updateListener (smoke: build does not throw with handler)', () => {
    const onChange = vi.fn();
    const state = makeState({ onChange });
    // Just confirm the state assembles; the updateListener is exercised
    // end-to-end in the component-level test below.
    expect(state).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('registers the RFC-0015 image display-attribute affordance as a built-in — no extra prop needed (AC-C3)', () => {
    const doc = '![alt](x.png){width=60%}';
    const state = EditorState.create({ doc, selection: { anchor: 2 }, extensions: buildExtensions({}) });
    ensureSyntaxTree(state, doc.length, 5_000);
    const tooltips = state.facet(showTooltip).filter((t) => t !== null);
    expect(tooltips).not.toHaveLength(0);
  });
});

/**
 * list-indent-keymap-fix — production key-dispatch priority (Backspace /
 * Enter) and readonly no-op verification.
 *
 * `makeState` above only builds an `EditorState`; it never routes a
 * `keydown` through CodeMirror's own keymap-resolution machinery
 * (`@codemirror/view`'s internal `handleKeyEvents` → `runScopeHandlers`).
 * Which of `listKeymap` / `defaultKeymap` actually wins for a given key —
 * in particular, whether the upstream `markdownKeymap`'s Backspace /
 * `Prec.high` Enter is really gone after `addKeymap: false` — can only be
 * observed by mounting a real `EditorView` with the same
 * `buildExtensions(...)` production uses and dispatching through
 * `runScopeHandlers(view, event, 'editor')`. `view.destroy()` is required
 * in `afterEach` (same reason as `image-affordance-extension.test.ts` /
 * `drop-handler.test.ts`): CodeMirror schedules an async layout-measure
 * pass that throws an uncaught exception under jsdom if left dangling.
 */
function mountView(doc: string, cursorAt: number, opts: Parameters<typeof buildExtensions>[0] = {}): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursorAt),
    extensions: buildExtensions(opts),
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return new EditorView({ state });
}

/** Dispatch a real `keydown` for `key` through the view's keymap resolution, the same path a browser keystroke takes. */
function dispatchKey(view: EditorView, key: string): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key }), 'editor');
}

describe('production key dispatch — Backspace (real EditorView + runScopeHandlers)', () => {
  let view: EditorView;
  afterEach(() => view?.destroy());

  it('deletes exactly one character at a level-0 list item content start (no marker snap)', () => {
    const doc = '- a';
    view = mountView(doc, doc.indexOf('a'));
    expect(dispatchKey(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('-a');
  });

  it('deletes exactly one character at a nested (depth 1) list item content start', () => {
    const doc = '- a\n  - b';
    view = mountView(doc, doc.indexOf('b'));
    expect(dispatchKey(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  -b');
  });

  it('deletes exactly one character at a depth-2 list item content start, including the 6-space CommonMark nesting threshold', () => {
    const doc = '- a\n  - b\n      - c';
    view = mountView(doc, doc.indexOf('c'));
    expect(dispatchKey(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n      -c');
  });

  it('deletes exactly one character at a blockquote content start — no markup-aware quote-mark removal (addKeymap:false strips list+blockquote deleteMarkupBackward together)', () => {
    const doc = '> quote';
    view = mountView(doc, doc.indexOf('quote'));
    expect(dispatchKey(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('>quote');
  });
});

describe('production key dispatch — Enter (real EditorView + runScopeHandlers)', () => {
  let view: EditorView;
  afterEach(() => view?.destroy());

  it('continueListMarkup wins over the upstream Enter now that addKeymap:false stops it shadowing (tight continuation of a loose list)', () => {
    const doc = '- z\n\n- x\n- y';
    view = mountView(doc, doc.indexOf('\n'));
    expect(dispatchKey(view, 'Enter')).toBe(true);
    expect(view.state.doc.toString()).toBe('- z\n- \n\n- x\n- y');
  });

  it('renumbers the rest of the ordered list on a mid-list Enter (falls through to insertNewlineContinueMarkup)', () => {
    const doc = '1. a\n2. b\n3. c';
    view = mountView(doc, doc.indexOf('b') + 1);
    expect(dispatchKey(view, 'Enter')).toBe(true);
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n3. \n4. c');
  });

  it('still inserts marker+1 on an Enter at the end of the ordered list (continueListMarkup handles the append case)', () => {
    const doc = '1. a\n2. b';
    view = mountView(doc, doc.length);
    expect(dispatchKey(view, 'Enter')).toBe(true);
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n3. ');
  });
});

describe('readonly no-op — Tab / Shift-Tab / Enter / Backspace never mutate view.state.doc (real EditorView + runScopeHandlers)', () => {
  let view: EditorView;
  afterEach(() => view?.destroy());

  it('Tab (indentListItem) is a no-op', () => {
    const doc = '- a\n  - b';
    view = mountView(doc, doc.indexOf('b'), { readonly: true });
    expect(dispatchKey(view, 'Tab')).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('Shift-Tab (dedentListItem) is a no-op', () => {
    const doc = '- a\n  - b';
    view = mountView(doc, doc.indexOf('b'), { readonly: true });
    expect(dispatchKey(view, 'Shift-Tab')).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('Enter is a no-op via the continueListMarkup path (a case that mutates when not readonly)', () => {
    const doc = '- a';
    view = mountView(doc, doc.length, { readonly: true });
    expect(dispatchKey(view, 'Enter')).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("Enter is a no-op via the Enter-fallback path (an empty item continueListMarkup already declines, isolating the fallback's own guard)", () => {
    const doc = '- a\n- ';
    view = mountView(doc, doc.length, { readonly: true });
    expect(dispatchKey(view, 'Enter')).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("Backspace is a no-op (defaultKeymap's deleteCharBackward guards state.readOnly itself)", () => {
    // `deleteCharBackward` itself returns `false` under readOnly (no
    // dispatch), but its `standardKeymap` binding also carries
    // `preventDefault: true` — `runScopeHandlers` reports that as
    // `handled` regardless of whether a command actually ran, so the
    // load-bearing assertion here is that the doc never changes, not
    // the raw `runScopeHandlers` return value.
    const doc = '- a\n  - b';
    view = mountView(doc, doc.indexOf('b'), { readonly: true });
    dispatchKey(view, 'Backspace');
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe('MarkdownEditor', () => {
  it('renders the initial value as the document body', () => {
    const { container } = render(<MarkdownEditor value="hello" onChange={() => {}} />);
    // CodeMirror writes the doc into the `.cm-content` element. querySelector is
    // intentional here — CodeMirror's internal DOM carries no accessible role, so
    // there is no semantic RTL query that reaches it.
    const content = container.querySelector('.cm-content');
    expect(content).not.toBeNull();
    expect(content?.textContent).toBe('hello');
  });

  it('invokes onChange when an external sync rewrites the document', () => {
    // The component compares the incoming `value` against the
    // current doc and only dispatches when they differ — verify
    // that path drives the listener.
    const onChange = vi.fn();
    const { rerender, container } = render(<MarkdownEditor value="one" onChange={onChange} />);
    // CodeMirror internal DOM — no accessible role; querySelector is intentional.
    expect(container.querySelector('.cm-content')?.textContent).toBe('one');

    act(() => {
      rerender(<MarkdownEditor value="two" onChange={onChange} />);
    });
    // CodeMirror internal DOM — no accessible role; querySelector is intentional.
    expect(container.querySelector('.cm-content')?.textContent).toBe('two');
    // The sync dispatch routes through the same updateListener that
    // user keystrokes do, so onChange should fire with the new body.
    expect(onChange).toHaveBeenCalledWith('two');
  });

  it('exposes insertAtCursor through the imperative handle', () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onChange = vi.fn();
    const { container } = render(<MarkdownEditor ref={ref} value="start" onChange={onChange} />);

    act(() => {
      ref.current?.insertAtCursor(' end');
    });

    // CodeMirror's default cursor is at offset 0 on a fresh state, so
    // the snippet lands at the beginning. The exact placement is less
    // important than the fact that insertAtCursor mutated the doc.
    // CodeMirror internal DOM — no accessible role; querySelector is intentional.
    const text = container.querySelector('.cm-content')?.textContent ?? '';
    expect(text).toContain('start');
    expect(text).toContain(' end');
    expect(onChange).toHaveBeenCalled();
  });

  it('does not call onChange when readonly and the doc is unchanged externally', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="locked" onChange={onChange} readonly />);
    // No external sync, no user input → no onChange. This guards
    // against the readonly path accidentally dispatching the initial
    // doc back through the listener.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('forwards extraExtensions to the underlying EditorState', () => {
    // We can't peek at the live view's facets via the public API here,
    // so we re-run the builder to confirm extraExtensions flow through
    // — combined with the rendering smoke test above, this covers the
    // documented contract.
    const stateWithExtra = EditorState.create({
      doc: '',
      extensions: buildExtensions({ extraExtensions: [EditorState.readOnly.of(true)] }),
    });
    expect(stateWithExtra.readOnly).toBe(true);
  });
});
