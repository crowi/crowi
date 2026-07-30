import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `RendererStylesheets` calls `useAppInfo()` (a `useQuery`); mock it like
// `link-share-popover.test.tsx` does so the test doesn't need a real
// `QueryClientProvider`.
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));

// Deterministic, origin-prefixing stand-in for the real `resolveApiUrl`
// (already covered directly in `api-client.test.ts`) — keeps this file's
// assertions about link href values independent of the real
// `NEXT_PUBLIC_API_URL` runtime-env read.
const { resolveApiUrl } = vi.hoisted(() => ({
  resolveApiUrl: vi.fn((path: string) => `https://api.example.test${path}`),
}));
vi.mock('@/lib/api-client', () => ({ resolveApiUrl }));

import type { AppInfoQuery } from '@/lib/use-app-info.test-helpers';
import { makeAppInfo } from '@/lib/use-app-info.test-helpers';
import { RendererStylesheets } from './renderer-stylesheets';

function mockAppInfo(overrides: Partial<AppInfoQuery> = {}): void {
  useAppInfo.mockReturnValue({ data: undefined, isLoading: false, isError: false, ...overrides });
}

function mountedLinks(): HTMLLinkElement[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[data-crowi-renderer-stylesheet]'));
}

afterEach(() => {
  cleanup();
  // Belt-and-suspenders: a test whose assertions fail before rendering
  // reaches unmount could otherwise leak a `<link>` into the next test's
  // `document.head` (shared jsdom document across the file).
  for (const link of mountedLinks()) link.remove();
});

describe('RendererStylesheets', () => {
  it('renders no DOM output of its own', () => {
    mockAppInfo();
    const { container } = render(<RendererStylesheets />);
    expect(container.innerHTML).toBe('');
  });

  it('never gates sibling content — renders immediately regardless of the app-info query state', () => {
    mockAppInfo({ isLoading: true, data: undefined });
    render(
      <>
        <RendererStylesheets />
        <div data-testid="sibling">shell content</div>
      </>,
    );
    // No `act`/`waitFor` — the assertion runs synchronously right after
    // `render()`. If this component ever grew a loading/blocking branch,
    // this would be the first thing to fail.
    expect(screen.getByTestId('sibling')).toHaveTextContent('shell content');
  });

  it('inserts a <link rel="stylesheet"> per manifest entry, resolved through resolveApiUrl', () => {
    mockAppInfo({ data: makeAppInfo({ rendererStylesheets: ['/api/plugins/@crowi/plugin-renderer-katex/katex.css'] }) });
    render(<RendererStylesheets />);

    const links = mountedLinks();
    expect(links).toHaveLength(1);
    expect(links[0].rel).toBe('stylesheet');
    expect(links[0].href).toBe('https://api.example.test/api/plugins/@crowi/plugin-renderer-katex/katex.css');
    expect(links[0].getAttribute('data-crowi-renderer-stylesheet')).toBe('/api/plugins/@crowi/plugin-renderer-katex/katex.css');
  });

  it('does not gate on — and is unaffected by — a stylesheet <link> that never fires load or error (black-holed CSS)', () => {
    mockAppInfo({ data: makeAppInfo({ rendererStylesheets: ['/api/plugins/@crowi/plugin-renderer-katex/katex.css'] }) });
    render(
      <>
        <RendererStylesheets />
        <div data-testid="sibling">shell content</div>
      </>,
    );

    const [link] = mountedLinks();
    expect(link).toBeDefined();
    // Deliberately never dispatch `load` or `error` on `link` — the point
    // of this test is that nothing downstream is waiting on either event.
    expect(screen.getByTestId('sibling')).toHaveTextContent('shell content');
    // No onload/onerror handler was ever attached.
    expect(link.onload).toBeNull();
    expect(link.onerror).toBeNull();
  });

  it('renders nothing when the manifest is empty', () => {
    mockAppInfo({ data: makeAppInfo({ rendererStylesheets: [] }) });
    render(<RendererStylesheets />);
    expect(mountedLinks()).toHaveLength(0);
  });

  it('dedupes: two instances that resolve to the same href share one <link> (ref-counted)', () => {
    mockAppInfo({ data: makeAppInfo({ rendererStylesheets: ['/api/plugins/@crowi/plugin-renderer-katex/katex.css'] }) });
    render(
      <>
        <RendererStylesheets />
        <RendererStylesheets />
      </>,
    );
    expect(mountedLinks()).toHaveLength(1);
  });

  it('diffs on manifest change: keeps an unchanged href, drops a removed one, adds a new one', () => {
    mockAppInfo({
      data: makeAppInfo({
        rendererStylesheets: ['/api/plugins/@crowi/plugin-a/a.css', '/api/plugins/@crowi/plugin-b/b.css'],
      }),
    });
    const { rerender } = render(<RendererStylesheets />);
    expect(
      mountedLinks()
        .map((l) => l.getAttribute('data-crowi-renderer-stylesheet'))
        .sort(),
    ).toEqual(['/api/plugins/@crowi/plugin-a/a.css', '/api/plugins/@crowi/plugin-b/b.css']);

    mockAppInfo({
      data: makeAppInfo({
        rendererStylesheets: ['/api/plugins/@crowi/plugin-a/a.css', '/api/plugins/@crowi/plugin-c/c.css'],
      }),
    });
    rerender(<RendererStylesheets />);

    const hrefsAfter = mountedLinks()
      .map((l) => l.getAttribute('data-crowi-renderer-stylesheet'))
      .sort();
    expect(hrefsAfter).toEqual(['/api/plugins/@crowi/plugin-a/a.css', '/api/plugins/@crowi/plugin-c/c.css']);
  });

  it('removes its <link>s on unmount', () => {
    mockAppInfo({ data: makeAppInfo({ rendererStylesheets: ['/api/plugins/@crowi/plugin-renderer-katex/katex.css'] }) });
    const { unmount } = render(<RendererStylesheets />);
    expect(mountedLinks()).toHaveLength(1);

    unmount();
    expect(mountedLinks()).toHaveLength(0);
  });

  it('a same-content refetch (new array reference, identical values) does not remove and reinsert the <link>', () => {
    mockAppInfo({ data: makeAppInfo({ rendererStylesheets: ['/api/plugins/@crowi/plugin-renderer-katex/katex.css'] }) });
    const { rerender } = render(<RendererStylesheets />);
    const [linkBefore] = mountedLinks();

    // A fresh array literal with the same single value — `useQuery` returns
    // a new reference on every successful fetch even when the JSON is
    // byte-identical.
    mockAppInfo({ data: makeAppInfo({ rendererStylesheets: ['/api/plugins/@crowi/plugin-renderer-katex/katex.css'] }) });
    rerender(<RendererStylesheets />);

    const [linkAfter] = mountedLinks();
    expect(mountedLinks()).toHaveLength(1);
    expect(linkAfter).toBe(linkBefore);
  });
});
