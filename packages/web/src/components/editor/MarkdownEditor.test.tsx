import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createRef } from 'react';
import { EditorState } from '@codemirror/state';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { buildExtensions } from './build-extensions';

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
});

describe('MarkdownEditor', () => {
  it('renders the initial value as the document body', () => {
    const { container } = render(<MarkdownEditor value="hello" onChange={() => {}} />);
    // CodeMirror writes the doc into the `.cm-content` element. We
    // assert on textContent rather than DOM shape so the test is
    // resilient to internal codemirror layout changes.
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
    expect(container.querySelector('.cm-content')?.textContent).toBe('one');

    act(() => {
      rerender(<MarkdownEditor value="two" onChange={onChange} />);
    });
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
