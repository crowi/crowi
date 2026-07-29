import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, Suspense } from 'react';
import { render, cleanup, screen } from '@testing-library/react';

/**
 * feature-page-link-space-paths Phase 1 — trash route double-decode fix.
 *
 * Next's catch-all route matcher already `decodeURIComponent`s each
 * `params.slug[]` segment before this component ever sees it (unlike
 * `usePathname()`, used by the main `[[...slug]]/page.tsx` catch-all, which
 * stays percent-encoded). This component previously ran `decodePagePathFromUrl`
 * (percent-decode + `+`→space) on an already-decoded segment, double-decoding
 * it. It must use `decodeRouteParamSegment` (`+`→space only, no
 * percent-decode) instead — these tests pin down both halves of that
 * contract at the component level.
 */

const { capturedProps } = vi.hoisted(() => ({ capturedProps: { value: undefined as unknown } }));
vi.mock('@/components/page-list/page-list', () => ({
  PageList: (props: unknown) => {
    capturedProps.value = props;
    return <div data-testid="page-list" />;
  },
}));

vi.mock('@/lib/use-page-title', () => ({ usePageTitle: vi.fn() }));

import TrashCatchAllPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  capturedProps.value = undefined;
});

describe('(auth)/trash/[[...slug]]/page — route-param decode (no double-decode)', () => {
  it('decodes a "+"-joined legacy segment to a real space', async () => {
    // Next's route matcher already decodeURIComponent'd this segment; the
    // literal '+' it hands us must become a space (decodeRouteParamSegment),
    // matching the same `+`-as-space contract `pagePathToHref` /
    // `decodePagePathFromUrl` use elsewhere.
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <TrashCatchAllPage params={Promise.resolve({ slug: ['mysql+connect+to+production+db'] })} />
        </Suspense>,
      );
    });

    expect(screen.getByTestId('page-list')).toBeInTheDocument();
    expect(capturedProps.value).toMatchObject({
      variant: 'trash',
      initialParams: { path: '/trash/mysql connect to production db/', include_deleted: true },
    });
  });

  it('does not re-decode a segment that already contains a literal "%" (double-decode would mangle it)', async () => {
    // Simulate what Next's route matcher hands the component for a raw URL
    // segment `a%2520b`: it runs decodeURIComponent ONCE upstream, turning
    // that into the literal string `a%20b` — a percent sign followed by
    // "20b", NOT a decoded space. If this component ran decodeURIComponent
    // again (the `decodePagePathFromUrl` bug), `a%20b` would wrongly become
    // `a b`. `decodeRouteParamSegment` must leave it as `a%20b`.
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <TrashCatchAllPage params={Promise.resolve({ slug: ['a%20b'] })} />
        </Suspense>,
      );
    });

    expect(capturedProps.value).toMatchObject({
      initialParams: { path: '/trash/a%20b/' },
    });
  });

  it('joins multiple segments and defaults to the bare /trash/ path when slug is absent', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <TrashCatchAllPage params={Promise.resolve({ slug: undefined })} />
        </Suspense>,
      );
    });

    expect(capturedProps.value).toMatchObject({ initialParams: { path: '/trash/', include_deleted: true } });
  });

  it('joins multiple decoded segments with "/"', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <TrashCatchAllPage params={Promise.resolve({ slug: ['crowi', 'a+b'] })} />
        </Suspense>,
      );
    });

    expect(capturedProps.value).toMatchObject({ initialParams: { path: '/trash/crowi/a b/' } });
  });
});
