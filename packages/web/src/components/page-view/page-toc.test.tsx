import { act, cleanup, render, screen } from '@testing-library/react';
import type { TocEntryResponse } from '@crowi/api-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TocList, useTocScrollSpy } from './page-toc';

afterEach(() => {
  cleanup();
});

describe('TocList', () => {
  it('renders a plain heading label and a #anchorId href', () => {
    const toc: TocEntryResponse[] = [{ level: 2, text: 'Getting started', anchorId: 'getting-started' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Getting started' });
    expect(link.getAttribute('href')).toBe('#getting-started');
  });

  it('strips inline HTML from the displayed label while keeping href = #anchorId', () => {
    // `entry.text` is the RAW (as-authored) heading text including inline HTML;
    // `anchorId` is the server-side slug of the STRIPPED text. The TOC must
    // show the clean label but still link to the (already-clean) anchorId.
    const toc: TocEntryResponse[] = [{ level: 3, text: '<font color="1a73e8">Workspace の作成</font>', anchorId: 'workspace-の作成' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Workspace の作成' });
    // Visible label has no `<font …>` markup left.
    expect(link.textContent).toBe('Workspace の作成');
    expect(link.textContent).not.toContain('<font');
    // The `title` attr is stripped too.
    expect(link.getAttribute('title')).toBe('Workspace の作成');
    // href / anchor is taken verbatim from the server-generated anchorId.
    expect(link.getAttribute('href')).toBe('#workspace-の作成');
  });

  it('leaves an unknown tag-like token (List<int>) intact in the label', () => {
    const toc: TocEntryResponse[] = [{ level: 2, text: 'Using List<int> in C#', anchorId: 'using-listint-in-c' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Using List<int> in C#' });
    expect(link.textContent).toBe('Using List<int> in C#');
    expect(link.getAttribute('href')).toBe('#using-listint-in-c');
  });

  it('strips inline presentational tags the body renderer keeps (<strike>, <tt>)', () => {
    // These tags are rendered as elements in the body, so the TOC label must
    // strip them too (strip set ⊇ the body renderer inline allow-list).
    const toc: TocEntryResponse[] = [{ level: 2, text: '<strike>Old</strike> and <tt>code</tt>', anchorId: 'old-and-code' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Old and code' });
    expect(link.textContent).toBe('Old and code');
    expect(link.getAttribute('href')).toBe('#old-and-code');
  });
});

// ── useTocScrollSpy: column-width observation ─────────────────────────────

const SPY_TOC: TocEntryResponse[] = [
  { level: 2, text: 'A', anchorId: 'a' },
  { level: 2, text: 'B', anchorId: 'b' },
  { level: 2, text: 'C', anchorId: 'c' },
];

function SpyHarness({ toc }: { toc: TocEntryResponse[] }) {
  const activeId = useTocScrollSpy(toc);
  return (
    <div data-reading-content>
      <span data-testid="active">{activeId ?? 'none'}</span>
      {toc.map((entry) => (
        <h2 key={entry.anchorId} id={entry.anchorId}>
          {entry.text}
        </h2>
      ))}
    </div>
  );
}

describe('useTocScrollSpy — column width observation', () => {
  let tops: Record<string, number>;
  let offsetTopReads: number;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let observers: Array<{ callback: ResizeObserverCallback; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }>;

  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of pending) callback(0);
    });
  };
  const notify = (width: number, height = 100) => {
    const observer = observers[observers.length - 1];
    act(() => observer.callback([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver));
  };
  const scrollTo = (y: number) => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
  };

  beforeEach(() => {
    tops = { a: 0, b: 300, c: 600 };
    offsetTopReads = 0;
    frames = new Map();
    nextFrame = 1;
    observers = [];
    scrollTo(250);
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      offsetTopReads += 1;
      return tops[this.id] ?? 0;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn();
        observed: Element[] = [];
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, observed: this.observed, disconnect: this.disconnect });
        }
        observe(target: Element) {
          this.observed.push(target);
        }
        unobserve() {}
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    scrollTo(0);
  });

  it('observes the reading column that holds the first heading', () => {
    render(<SpyHarness toc={SPY_TOC} />);
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toHaveLength(1);
    expect((observers[0].observed[0] as HTMLElement).hasAttribute('data-reading-content')).toBe(true);
  });

  it('updates the active heading after a width-only change moves the headings', () => {
    render(<SpyHarness toc={SPY_TOC} />);
    expect(screen.getByTestId('active').textContent).toBe('b');

    notify(800); // first notification
    flushFrames();
    // A wider column re-flows the text: heading B drops below the fold.
    tops = { a: 0, b: 500, c: 900 };
    notify(1200);
    flushFrames();

    expect(screen.getByTestId('active').textContent).toBe('a');
  });

  it('ignores a height-only notification: nothing is scheduled and nothing is re-read', () => {
    render(<SpyHarness toc={SPY_TOC} />);
    notify(800);
    flushFrames();
    const reads = offsetTopReads;

    notify(800, 4000);

    expect(frames.size).toBe(0);
    expect(offsetTopReads).toBe(reads);
  });

  it('folds scroll, resize and width notifications into one frame and one re-measure', () => {
    render(<SpyHarness toc={SPY_TOC} />);
    notify(800);
    flushFrames();
    const reads = offsetTopReads;

    act(() => {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    });
    notify(900);

    expect(frames.size).toBe(1);
    flushFrames();
    // One measure pass reads every heading once.
    expect(offsetTopReads - reads).toBe(SPY_TOC.length);

    // A plain scroll afterwards only compares; it does not re-read offsets.
    const afterMeasure = offsetTopReads;
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    flushFrames();
    expect(offsetTopReads).toBe(afterMeasure);
  });

  it('releases the observer, both listeners and a pending frame when the toc changes or the host unmounts', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { rerender, unmount } = render(<SpyHarness toc={SPY_TOC} />);
    notify(800);
    expect(frames.size).toBe(1);

    rerender(<SpyHarness toc={[SPY_TOC[0]]} />);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['scroll', 'resize']));

    // Fewer than two headings: nothing is observed at all.
    expect(observers).toHaveLength(1);
    rerender(<SpyHarness toc={SPY_TOC} />);
    expect(observers).toHaveLength(2);
    unmount();
    expect(observers[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to mount and window-resize measurement without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<SpyHarness toc={SPY_TOC} />);
    expect(screen.getByTestId('active').textContent).toBe('b');

    tops = { a: 0, b: 500, c: 900 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    flushFrames();
    expect(screen.getByTestId('active').textContent).toBe('a');
  });
});
