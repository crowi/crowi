import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, Suspense, Component, type ReactNode } from 'react';
import { render, cleanup, screen } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * feature-restricted-grant-share-banner Phase 1 — revival of the legacy
 * `/_r/<id>` alias route.
 *
 * Renaming the on-disk directory from the literal `_r` to `%5Fr` (the
 * URL-encoded `_`, matching sibling private-folder-avoiding routes like
 * `%5Fedit`) is what actually makes `/_r/<id>` route here instead of
 * falling through to the catch-all as a private-folder 404 — see the
 * spec's "背景" for why the literal-underscore directory was silently dead
 * since it landed. `[id]/page.tsx` itself is byte-for-byte unchanged by
 * the rename; these are route-level tests for that unchanged component,
 * newly meaningful now that the route actually resolves.
 */

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    // Mirrors the real `next/navigation` `notFound()` contract (return
    // type `never` — it always throws) so the component's control flow
    // after the `if (!isObjectId(id))` guard is exercised the same way it
    // would be in production: nothing after the guard runs once id is
    // invalid.
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound }));

vi.mock('@/components/id-redirector', () => ({
  IdRedirector: ({ pageId }: { pageId: string }) => <div data-testid="id-redirector">{pageId}</div>,
}));

import IdRedirectAliasPage from './page';

/** Catches the `notFound()` throw so the invalid-id test can observe it. */
class NotFoundBoundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { caught: false };
  }
  static getDerivedStateFromError() {
    return { caught: true };
  }
  render() {
    return this.state.caught ? null : this.props.children;
  }
}

const VALID_ID = '507f1f77bcf86cd799439011';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('(auth)/%5Fr/[id]/page — legacy /_r/<id> alias route revival', () => {
  it('mounts IdRedirector for a valid ObjectId segment', async () => {
    // `use(params)` suspends on the first render pass even for an
    // already-resolved promise (React only learns the value once its own
    // internal `.then()` tracking fires, which needs at least one
    // microtask tick) — `await act(async () => render(...))` lets that
    // resolution + the resulting re-render flush before we assert.
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <IdRedirectAliasPage params={Promise.resolve({ id: VALID_ID })} />
        </Suspense>,
      );
    });

    expect(screen.getByTestId('id-redirector')).toHaveTextContent(VALID_ID);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('calls notFound() for a non-ObjectId id segment, never mounting IdRedirector', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      render(
        <NotFoundBoundary>
          <Suspense fallback={null}>
            <IdRedirectAliasPage params={Promise.resolve({ id: 'not-an-object-id' })} />
          </Suspense>
        </NotFoundBoundary>,
      );
    });

    expect(notFound).toHaveBeenCalledWith();
    expect(screen.queryByTestId('id-redirector')).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  describe('production build manifest — direct evidence of the revival', () => {
    // The two tests above only prove the component behaves correctly in
    // isolation; they would pass identically even if the directory were
    // still the literal `_r` (dead — see the file-level doc comment above
    // and the spec's "背景"). The only direct evidence that Next.js's App
    // Router actually builds `/(auth)/%5Fr/[id]` into a servable route is
    // an entry in the prod build's `app-paths-manifest.json` (Next decodes
    // the `%5F` back to `_` for the manifest key). `pnpm --filter @crowi/web
    // build` already runs as a required check elsewhere in this feature's
    // workflow (and `pnpm build` / CI's own "Build project" step build it
    // again regardless), so this test reuses that artifact when present and
    // triggers a build itself otherwise — never silently skipping.
    const ROUTE_KEY = '/(auth)/_r/[id]/page';
    const readManifest = (p: string): Record<string, string> =>
      existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as Record<string, string>) : {};

    it('the built app-paths-manifest.json contains /(auth)/_r/[id]/page', () => {
      const manifestPath = path.join(process.cwd(), '.next/server/app-paths-manifest.json');

      // Trigger a build when the manifest is missing OR present but does not
      // yet carry the route. The second case is the common one on a dev box:
      // a running `next dev` writes a dev-mode manifest that lazily omits
      // routes never visited (including `%5Fr`), so a mere existsSync guard
      // would reuse that stale manifest and fail. Rebuilding when the key is
      // absent makes the test self-healing regardless of what wrote `.next`
      // (CI's fresh prod build already contains it, so it never rebuilds there).
      if (readManifest(manifestPath)[ROUTE_KEY] === undefined) {
        execSync('pnpm build', { cwd: process.cwd(), stdio: 'inherit' });
      }

      expect(readManifest(manifestPath)[ROUTE_KEY]).toBeDefined();
    }, 300_000);
  });
});
