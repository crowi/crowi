import { act, cleanup } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READING_WIDTH_ATTRIBUTE, READING_WIDTH_STORAGE_KEY } from '@/lib/reading-width';
import { ReadingWidthProvider, useReadingWidth } from './reading-width-provider';

function Probe({ label }: { label: string }) {
  const { preference, setPreference } = useReadingWidth();
  return (
    <div>
      <span data-testid="label">{label}</span>
      <span data-testid="preference">{preference}</span>
      <button type="button" onClick={() => setPreference(preference === 'full' ? 'standard' : 'full')}>
        toggle
      </button>
    </div>
  );
}

const root = () => document.documentElement;
const text = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup();
  container.remove();
  root().removeAttribute(READING_WIDTH_ATTRIBUTE);
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** Server-render, then hydrate the same DOM, collecting recoverable errors. */
function hydrate(ui: React.ReactElement) {
  container.innerHTML = renderToString(ui);
  const errors: unknown[] = [];
  let reactRoot!: ReturnType<typeof hydrateRoot>;
  act(() => {
    reactRoot = hydrateRoot(container, ui, { onRecoverableError: (error) => errors.push(error) });
  });
  return { reactRoot, errors };
}

describe('ReadingWidthProvider', () => {
  it('renders the standard width on the server even when the bootstrap already set full', () => {
    root().setAttribute(READING_WIDTH_ATTRIBUTE, 'full');
    expect(
      renderToString(
        <ReadingWidthProvider>
          <Probe label="a" />
        </ReadingWidthProvider>,
      ),
    ).toContain('standard');
  });

  it('adopts the bootstrapped full value on hydration without recoverable errors, rewrites nothing and saves nothing', () => {
    root().setAttribute(READING_WIDTH_ATTRIBUTE, 'full');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const attributeWrites = vi.spyOn(root(), 'setAttribute');

    const { errors } = hydrate(
      <ReadingWidthProvider>
        <Probe label="a" />
      </ReadingWidthProvider>,
    );

    expect(errors).toEqual([]);
    expect(text(container, 'preference')).toBe('full');
    expect(root().getAttribute(READING_WIDTH_ATTRIBUTE)).toBe('full');
    expect(setItem).not.toHaveBeenCalled();
    // The initial `standard` never clobbers the bootstrapped value.
    expect(attributeWrites.mock.calls.filter(([, value]) => value === 'standard')).toEqual([]);
  });

  it('treats a missing or unknown attribute as standard', () => {
    root().setAttribute(READING_WIDTH_ATTRIBUTE, 'bogus');
    hydrate(
      <ReadingWidthProvider>
        <Probe label="a" />
      </ReadingWidthProvider>,
    );
    expect(text(container, 'preference')).toBe('standard');
    expect(root().getAttribute(READING_WIDTH_ATTRIBUTE)).toBe('standard');
  });

  it('saves only on an explicit change and mirrors it onto the root attribute', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    hydrate(
      <ReadingWidthProvider>
        <Probe label="a" />
      </ReadingWidthProvider>,
    );
    expect(setItem).not.toHaveBeenCalled();

    act(() => container.querySelector('button')?.click());

    expect(text(container, 'preference')).toBe('full');
    expect(root().getAttribute(READING_WIDTH_ATTRIBUTE)).toBe('full');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(READING_WIDTH_STORAGE_KEY)).toBe('full');
  });

  it('keeps the same state across a children swap even when saving throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const { reactRoot } = hydrate(
      <ReadingWidthProvider>
        <Probe label="first" />
      </ReadingWidthProvider>,
    );

    act(() => container.querySelector('button')?.click());
    expect(text(container, 'preference')).toBe('full');

    // A client-side navigation replaces the page below the provider.
    act(() =>
      reactRoot.render(
        <ReadingWidthProvider>
          <Probe label="second" />
        </ReadingWidthProvider>,
      ),
    );
    expect(text(container, 'label')).toBe('second');
    expect(text(container, 'preference')).toBe('full');
    expect(root().getAttribute(READING_WIDTH_ATTRIBUTE)).toBe('full');
  });

  it('outside a provider the hook reports standard with a no-op setter', () => {
    container.innerHTML = renderToString(<Probe label="x" />);
    expect(text(container, 'preference')).toBe('standard');
  });
});
