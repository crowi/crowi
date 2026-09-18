import { ARTIFACT_HEIGHT_MESSAGE_TYPE, type AppInfoResponse, type PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAppInfo } from '@/lib/use-app-info.test-helpers';

const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
const { useMintArtifactUrl } = vi.hoisted(() => ({ useMintArtifactUrl: vi.fn() }));
// Real network boundary for the one test that renders the REAL
// `useMintArtifactUrl` (see the AC-SH-8 MutationCache test below) instead of
// the `vi.fn()` above — every other test in this file only ever sees the
// mocked hook and never reaches this.
const { mintArtifactUrlRequest } = vi.hoisted(() => ({ mintArtifactUrlRequest: vi.fn() }));

vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/use-artifact-url', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-artifact-url')>('@/lib/use-artifact-url');
  return { ...actual, useMintArtifactUrl };
});
vi.mock('@/lib/api-client', () => ({
  apiClient: { pages: { ':id': { 'artifact-url': { $post: mintArtifactUrlRequest } } } },
}));
// `env()` caches `process.env.NEXT_PUBLIC_*` once at module load — mock it to
// read live from `process.env` so per-test `vi.stubEnv` actually takes
// effect (matches resolve-ws-url.test.ts's established pattern).
vi.mock('@/lib/runtime-env', () => ({ env: (key: string) => process.env[key] }));

import { ArtifactUrlUnavailableFailure } from '@/lib/use-artifact-url';
import { ArtifactView } from './artifact-view';

const ARTIFACT_ORIGIN = 'https://artifacts.example.net';
const ENABLED_APP_INFO = makeAppInfo({ artifactDelivery: { enabled: true, origin: ARTIFACT_ORIGIN } });

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-1',
    path: '/docs/agent-output',
    revision: {
      _id: 'rev-1',
      path: '/docs/agent-output',
      body: '<!doctype html><html><body>hi</body></html>',
      format: 'artifact',
      createdAt: '2026-05-01T00:00:00.000Z',
      contentType: 'artifact',
    },
    creator: null,
    lastUpdateUser: null,
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    ...overrides,
  } as PageWithRevision;
}

function pageWithRevisionId(id: string): PageWithRevision {
  const base = makePage();
  return { ...base, revision: { ...base.revision, _id: id } };
}

function mockAppInfo(overrides: Partial<{ data: AppInfoResponse | undefined; isLoading: boolean; isError: boolean; refetch: ReturnType<typeof vi.fn> }> = {}) {
  useAppInfo.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn(), ...overrides });
}

function mockMintWithReset(mutateAsync: ReturnType<typeof vi.fn> = vi.fn()) {
  const reset = vi.fn();
  useMintArtifactUrl.mockReturnValue({ mutateAsync, isPending: false, reset });
  return { mutateAsync, reset };
}

/** Same as {@link mockMintWithReset}, but for a test that only needs `mutateAsync`. */
function mockMint(mutateAsync: ReturnType<typeof vi.fn> = vi.fn()) {
  return mockMintWithReset(mutateAsync).mutateAsync;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes the microtask queue inside `act` for a promise resolved outside of `fireEvent`. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mintSuccess(url: string) {
  return { url, expiresAt: '2026-05-01T00:01:00.000Z' };
}

/**
 * Spies on every `console` method a leak could plausibly go through, not
 * just `console.error` — AC-SH-8 requires the URL/token never reach the
 * console, and a stray `console.log`/`warn`/`info`/`debug` of the minted
 * response would otherwise pass a narrower error-only spy.
 */
function spyOnAllConsoleMethods() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
  };
}

/** Asserts none of `spyOnAllConsoleMethods()`'s spies ever logged `needle`. */
function expectNoConsoleLeak(spies: ReturnType<typeof spyOnAllConsoleMethods>, needle: string) {
  for (const spy of Object.values(spies)) {
    for (const call of spy.mock.calls) {
      // Stringify twice: `.map(String)` catches plain string/number args,
      // `JSON.stringify` catches an object arg (e.g. `console.log({ url })`)
      // that `String()` would otherwise flatten to `[object Object]`,
      // hiding the leak.
      expect(call.map(String).join(' ')).not.toContain(needle);
      expect(JSON.stringify(call)).not.toContain(needle);
    }
  }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_ARTIFACT_ORIGIN', ARTIFACT_ORIGIN);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // `clearAllMocks()` clears call history but not a `mockImplementation` —
  // without this, the one test that points `useMintArtifactUrl` at the real
  // hook would leak that implementation into every later test.
  useMintArtifactUrl.mockReset();
  mintArtifactUrlRequest.mockReset();
});

describe('ArtifactView', () => {
  it('AC-SH-1: auto-mints as soon as delivery is confirmed enabled, showing only the preparing spinner until the mint resolves', () => {
    mockAppInfo({ data: ENABLED_APP_INFO });
    const { promise } = deferred<{ url: string; expiresAt: string }>();
    const mutateAsync = mockMint(vi.fn().mockReturnValue(promise));
    render(createElement(ArtifactView, { page: makePage() }));

    // The mint call itself is synchronous (it happens before `handleRun`'s
    // first `await`), so it has already fired by the time `render()`
    // returns — but nothing renders the iframe until that call resolves.
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ pageId: 'page-1', revisionId: 'rev-1' });
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain(m['page.artifact.preparing']());
    expect(screen.queryByText(m['page.artifact.placeholder_title']())).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('AC-SH-2: auto-run mints exactly once and creates one iframe pointed at the intermediate document', async () => {
    mockAppInfo({ data: ENABLED_APP_INFO });
    const mintedUrl = `${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok`;
    const mutateAsync = mockMint(vi.fn().mockResolvedValue(mintSuccess(mintedUrl)));
    render(createElement(ArtifactView, { page: makePage() }));

    await flush();

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ pageId: 'page-1', revisionId: 'rev-1' });
    const iframes = document.querySelectorAll('iframe');
    expect(iframes).toHaveLength(1);
    expect(iframes[0]?.getAttribute('src')).toBe(`/_artifact-frame?src=${encodeURIComponent(mintedUrl)}`);
  });

  it('AC-SH-2: an unrelated re-render while the auto-triggered mint is pending does not fire a second mint', async () => {
    mockAppInfo({ data: ENABLED_APP_INFO });
    const { promise, resolve } = deferred<{ url: string; expiresAt: string }>();
    const mutateAsync = mockMint(vi.fn().mockReturnValue(promise));
    const { rerender } = render(createElement(ArtifactView, { page: makePage() }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    // Same revision, same props — a re-render a parent could trigger for
    // reasons unrelated to this component (e.g. its own state changing)
    // must not fire a second mint.
    rerender(createElement(ArtifactView, { page: makePage() }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok`));
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('AC-SH-3: the outer iframe carries neither sandbox nor referrerPolicy', async () => {
    mockAppInfo({ data: ENABLED_APP_INFO });
    mockMint(vi.fn().mockResolvedValue(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok`)));
    render(createElement(ArtifactView, { page: makePage() }));

    await flush();

    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.hasAttribute('sandbox')).toBe(false);
    expect(iframe?.hasAttribute('referrerpolicy')).toBe(false);
  });

  it('AC-SH-4: shows the sandbox notice as a sibling of the iframe (not a descendant), with both required points', async () => {
    mockAppInfo({ data: ENABLED_APP_INFO });
    mockMint(vi.fn().mockResolvedValue(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok`)));
    render(createElement(ArtifactView, { page: makePage() }));

    await flush();

    const iframe = document.querySelector('iframe');
    const generated = screen.getByText(m['page.artifact.sandbox_notice_generated']());
    const inputNote = screen.getByText(m['page.artifact.sandbox_notice_input_note']());
    expect(iframe?.contains(generated)).toBe(false);
    expect(iframe?.contains(inputNote)).toBe(false);
    // The above only rules out "inside the iframe" — pin the actually
    // required relationship (the notices must render as siblings of the
    // iframe, not just anywhere outside it) by walking each text node up
    // to whichever ancestor is a DIRECT child of the iframe's own parent,
    // and asserting that ancestor's parent is the iframe's parent (i.e. it
    // is a sibling of the iframe, not merely a non-descendant living
    // somewhere else in the tree).
    const siblingContainerOf = (el: Element): Element | null => {
      let node: Element | null = el;
      while (node && node.parentElement !== iframe?.parentElement) {
        node = node.parentElement;
      }
      return node;
    };
    const generatedContainer = siblingContainerOf(generated);
    const inputNoteContainer = siblingContainerOf(inputNote);
    expect(generatedContainer).not.toBeNull();
    expect(inputNoteContainer).not.toBeNull();
    expect(generatedContainer?.parentElement).toBe(iframe?.parentElement);
    expect(inputNoteContainer?.parentElement).toBe(iframe?.parentElement);
  });

  it('AC-SH-5: the running state offers no controls — only the frame and the notice', async () => {
    mockAppInfo({ data: ENABLED_APP_INFO });
    mockMint(vi.fn().mockResolvedValue(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok`)));
    render(createElement(ArtifactView, { page: makePage() }));

    await flush();

    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('AC-SH-5: retrying after a failed mint mints again rather than reusing anything from the failed attempt', async () => {
    mockAppInfo({ data: ENABLED_APP_INFO });
    const mutateAsync = mockMint(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok2`)),
    );
    render(createElement(ArtifactView, { page: makePage() }));
    await flush();
    expect(screen.getByText(m['page.artifact.mint_failed_title']())).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m['page.artifact.retry_button']() }));
    });

    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain('tok2');
  });

  describe('AC-SH-6: the displayed revision fences which mint response can apply', () => {
    it('changing the displayed revision resets to idle, removes the iframe, drops the mint from the MutationCache, and auto-runs the NEW revision', async () => {
      mockAppInfo({ data: ENABLED_APP_INFO });
      const { reset } = mockMintWithReset(
        vi
          .fn()
          .mockResolvedValueOnce(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok`))
          .mockResolvedValueOnce(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r2?t=tok2`)),
      );
      const { rerender } = render(createElement(ArtifactView, { page: pageWithRevisionId('rev-1') }));
      await flush();
      expect(document.querySelectorAll('iframe')).toHaveLength(1);
      reset.mockClear(); // discard the mount-time no-op call; isolate the revision-change call

      rerender(createElement(ArtifactView, { page: pageWithRevisionId('rev-2') }));
      expect(document.querySelectorAll('iframe')).toHaveLength(0);
      // The displayed revision changing out from under a running artifact
      // must drop the MutationCache entry, not just the component's own
      // `runningUrl` state.
      expect(reset).toHaveBeenCalledTimes(1);

      // Revision navigation re-arms auto-run: the new revision mints and
      // runs on its own, no click required.
      await flush();
      expect(document.querySelector('iframe')?.getAttribute('src')).toContain('tok2');
    });

    it('a mint pending when the revision changes is discarded once it resolves, while the NEW revision auto-mints on its own', async () => {
      mockAppInfo({ data: ENABLED_APP_INFO });
      const stale = deferred<{ url: string; expiresAt: string }>();
      const fresh = deferred<{ url: string; expiresAt: string }>();
      const mutateAsync = mockMint(vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise));
      const { rerender } = render(createElement(ArtifactView, { page: pageWithRevisionId('rev-1') }));
      expect(mutateAsync).toHaveBeenCalledTimes(1); // rev-1's own auto-mint, still pending

      rerender(createElement(ArtifactView, { page: pageWithRevisionId('rev-2') }));
      expect(document.querySelectorAll('iframe')).toHaveLength(0);
      // rev-2's auto-run fires in the same commit as the revision change.
      expect(mutateAsync).toHaveBeenCalledTimes(2);
      expect(mutateAsync).toHaveBeenLastCalledWith({ pageId: 'page-1', revisionId: 'rev-2' });

      await act(async () => {
        stale.resolve(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=stale`));
      });
      // The stale rev-1 response must never render, even though it
      // resolved after rev-2's own (unrelated) mint was already in flight.
      expect(document.querySelectorAll('iframe')).toHaveLength(0);

      await act(async () => {
        fresh.resolve(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r2?t=fresh`));
      });
      expect(document.querySelector('iframe')?.getAttribute('src')).toContain('fresh');
    });

    it("still auto-mints the new revision while the hook reports the old revision's mint as pending", async () => {
      mockAppInfo({ data: ENABLED_APP_INFO });
      const fresh = deferred<{ url: string; expiresAt: string }>();
      const mutateAsync = vi
        .fn()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockReturnValueOnce(fresh.promise);
      const { reset } = mockMintWithReset(mutateAsync);
      const { rerender } = render(createElement(ArtifactView, { page: pageWithRevisionId('rev-1') }));

      // TanStack reports the rev-1 mint as pending on the render that
      // carries the revision switch; the switch itself is what resets it.
      useMintArtifactUrl.mockReturnValue({ mutateAsync, isPending: true, reset });
      rerender(createElement(ArtifactView, { page: pageWithRevisionId('rev-2') }));

      expect(mutateAsync).toHaveBeenCalledTimes(2);
      expect(mutateAsync).toHaveBeenLastCalledWith({ pageId: 'page-1', revisionId: 'rev-2' });
      await act(async () => {
        fresh.resolve(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r2?t=fresh`));
      });
      expect(document.querySelector('iframe')?.getAttribute('src')).toContain('fresh');
    });

    it('A → B → A discards a stale A-epoch mint even though the revision id matches again', async () => {
      mockAppInfo({ data: ENABLED_APP_INFO });
      const staleA = deferred<{ url: string; expiresAt: string }>();
      const neverResolves = new Promise<{ url: string; expiresAt: string }>(() => {});
      // Only the FIRST (initial rev-A) auto-mint is observed by this test;
      // the rev-B and second rev-A auto-mints are given a promise that
      // never settles, since this test only cares whether the FIRST A's
      // stale response can still leak through after A → B → A.
      mockMint(vi.fn().mockReturnValueOnce(staleA.promise).mockReturnValue(neverResolves));
      const { rerender } = render(createElement(ArtifactView, { page: pageWithRevisionId('rev-A') }));

      rerender(createElement(ArtifactView, { page: pageWithRevisionId('rev-B') }));
      rerender(createElement(ArtifactView, { page: pageWithRevisionId('rev-A') }));
      expect(document.querySelectorAll('iframe')).toHaveLength(0);

      await act(async () => {
        staleA.resolve(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/rA?t=stale`));
      });
      expect(document.querySelectorAll('iframe')).toHaveLength(0);
    });
  });

  describe('AC-SH-7: auto-run only fires once delivery is positively confirmed enabled', () => {
    it('does not auto-run while app info is loading, showing only the preparing spinner', () => {
      mockAppInfo({ isLoading: true });
      const mutateAsync = mockMint();
      render(createElement(ArtifactView, { page: makePage() }));

      expect(screen.getByRole('status').textContent).toContain(m['page.artifact.preparing']());
      expect(screen.queryByText(m['page.artifact.placeholder_title']())).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('does not auto-run when app info failed to load, offering only a way to check again (fail-closed)', () => {
      const refetch = vi.fn();
      mockAppInfo({ isError: true, refetch });
      const mutateAsync = mockMint();
      render(createElement(ArtifactView, { page: makePage() }));

      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByText(m['page.artifact.placeholder_title']())).toBeTruthy();
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([m['page.artifact.retry_button']()]);
      expect(mutateAsync).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: m['page.artifact.retry_button']() }));
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('does not auto-run and shows the disabled-delivery guidance when enabled === false', () => {
      mockAppInfo({ data: makeAppInfo({ artifactDelivery: { enabled: false, origin: null } }) });
      const mutateAsync = mockMint();
      render(createElement(ArtifactView, { page: makePage() }));

      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByText(m['page.artifact.delivery_unavailable_body']())).toBeTruthy();
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('auto-runs, with the exact page/revision, once enabled === true is confirmed', () => {
      mockAppInfo({ data: ENABLED_APP_INFO });
      const mutateAsync = mockMint();
      render(createElement(ArtifactView, { page: makePage() }));

      expect(mutateAsync).toHaveBeenCalledTimes(1);
      expect(mutateAsync).toHaveBeenCalledWith({ pageId: 'page-1', revisionId: 'rev-1' });
    });

    it('a 422 (delivery not configured) mint failure shows the same disabled-delivery guidance as the enabled === false case', async () => {
      mockAppInfo({ data: ENABLED_APP_INFO });
      mockMint(vi.fn().mockRejectedValue(new ArtifactUrlUnavailableFailure('ARTIFACT_DELIVERY_NOT_CONFIGURED', 'fixed message')));
      render(createElement(ArtifactView, { page: makePage() }));

      await flush();

      expect(screen.getByText(m['page.artifact.delivery_unavailable_body']())).toBeTruthy();
    });
  });

  describe('AC-SH-8: origin mismatches never create an iframe and never leak the URL/token', () => {
    it('the minted URL origin differs from app info — no iframe, mismatch shown, url/token not leaked, and the mint is dropped from the MutationCache', async () => {
      mockAppInfo({ data: ENABLED_APP_INFO });
      const mintedUrl = 'https://not-the-configured-origin.example/api/artifact/p1/r1?t=SECRET_TOKEN_VALUE';
      const { reset } = mockMintWithReset(vi.fn().mockResolvedValue(mintSuccess(mintedUrl)));
      const consoleSpies = spyOnAllConsoleMethods();
      render(createElement(ArtifactView, { page: makePage() }));
      reset.mockClear(); // discard the mount-time no-op call; isolate this failure path's own call

      await flush();

      expect(document.querySelectorAll('iframe')).toHaveLength(0);
      expect(screen.getByText(m['page.artifact.origin_mismatch_title']())).toBeTruthy();
      expect(document.body.textContent).not.toContain('SECRET_TOKEN_VALUE');
      expect(document.body.textContent).not.toContain(mintedUrl);
      expectNoConsoleLeak(consoleSpies, 'SECRET_TOKEN_VALUE');
      expectNoConsoleLeak(consoleSpies, mintedUrl);
      // A successful mint response still carries a live token even after
      // this component decides never to render it — must not linger in the
      // MutationCache, any more than an abandoned run's does.
      expect(reset).toHaveBeenCalledTimes(1);
      // A DYNAMIC mismatch (discovered after an actual mint attempt) gets
      // the ordinary "reason + retry" treatment, unlike the STATIC pre-mint
      // mismatch below (nothing to retry — no attempt was ever made).
      expect(screen.getByRole('button', { name: m['page.artifact.retry_button']() })).toBeTruthy();
    });

    it('a mismatched mint response is actually gone from the real MutationCache, not just observed via a reset() spy', async () => {
      // Every other test in this describe block replaces `useMintArtifactUrl`
      // with a bare mock and can only prove `reset()` was CALLED. This test
      // renders the REAL hook (bypassing the module mock via `importActual`)
      // behind a real `QueryClient`, so the assertion is against the actual
      // cache TanStack Query maintains, not a spy's call count.
      const actual = await vi.importActual<typeof import('@/lib/use-artifact-url')>('@/lib/use-artifact-url');
      useMintArtifactUrl.mockImplementation(actual.useMintArtifactUrl);

      mockAppInfo({ data: ENABLED_APP_INFO });
      const mintedUrl = 'https://not-the-configured-origin.example/api/artifact/p1/r1?t=SECRET_TOKEN_VALUE';
      mintArtifactUrlRequest.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mintSuccess(mintedUrl),
      });
      const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      // A synchronous read can't reliably catch the mutation WHILE it's
      // still in the cache: flushing an async `act()` call in this harness
      // drains the same real timer queue `gcTime: 0` schedules removal on,
      // so the mutation is often already gone by the time control returns
      // here. Subscribing to cache events instead proves it was tracked at
      // all (an `added` event fired) regardless of exactly when it's read.
      const cacheEvents: string[] = [];
      client.getMutationCache().subscribe((event) => cacheEvents.push(event.type));
      render(createElement(QueryClientProvider, { client }, createElement(ArtifactView, { page: makePage() })));

      await flush();
      // Explicit extra tick in case this harness's own timer draining
      // didn't already cover `gcTime: 0`'s scheduled removal.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(document.querySelectorAll('iframe')).toHaveLength(0);
      expect(screen.getByText(m['page.artifact.origin_mismatch_title']())).toBeTruthy();
      expect(cacheEvents).toContain('added');
      expect(client.getMutationCache().getAll()).toHaveLength(0);
    });

    it("app info's own origin disagrees with this replica's configured web origin — never even attempts to auto-run, never mints, and offers no retry (nothing was attempted)", () => {
      const mismatchedOrigin = 'https://a-different-origin.example';
      mockAppInfo({ data: makeAppInfo({ artifactDelivery: { enabled: true, origin: mismatchedOrigin } }) });
      const mutateAsync = mockMint();
      const consoleSpies = spyOnAllConsoleMethods();
      render(createElement(ArtifactView, { page: makePage() }));

      expect(screen.queryByRole('button')).toBeNull();
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(screen.getByText(m['page.artifact.origin_mismatch_title']())).toBeTruthy();
      expect(screen.queryByRole('button', { name: m['page.artifact.retry_button']() })).toBeNull();
      expect(document.body.textContent).not.toContain(mismatchedOrigin);
      expectNoConsoleLeak(consoleSpies, mismatchedOrigin);
    });
  });

  describe('the frame takes the height the artifact reports', () => {
    /**
     * Renders a running artifact and stands in for what `/_artifact-frame`
     * loads: one nested frame, whose window is the only sender whose
     * height reports count.
     */
    async function renderRunningFrame() {
      mockAppInfo({ data: ENABLED_APP_INFO });
      mockMint(vi.fn().mockResolvedValue(mintSuccess(`${ARTIFACT_ORIGIN}/api/artifact/p1/r1?t=tok`)));
      render(createElement(ArtifactView, { page: makePage() }));
      await flush();
      const frame = document.querySelector('iframe');
      if (!frame?.contentDocument) throw new Error('the outer frame did not render');
      // jsdom never loads the outer frame's `src`, so its document is empty.
      const outerDocument = frame.contentDocument;
      const artifactFrame = outerDocument.createElement('iframe');
      (outerDocument.documentElement ?? outerDocument.appendChild(outerDocument.createElement('html'))).appendChild(artifactFrame);
      if (!artifactFrame.contentWindow) throw new Error('the nested frame has no window');
      return { frame, artifactWindow: artifactFrame.contentWindow };
    }

    function post(source: Window, data: unknown) {
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data, source }));
      });
    }

    it('keeps the fixed fallback height until a report arrives', async () => {
      const { frame } = await renderRunningFrame();
      expect(frame.className).toContain('h-[70vh]');
      expect(frame.style.height).toBe('');
    });

    it('sizes the frame to a report from the artifact window and drops the fallback height', async () => {
      const { frame, artifactWindow } = await renderRunningFrame();
      post(artifactWindow, { type: ARTIFACT_HEIGHT_MESSAGE_TYPE, height: 2400.4 });
      expect(frame.style.height).toBe('2401px');
      expect(frame.className).not.toContain('h-[70vh]');
      expect(frame.className).not.toContain('min-h-');
    });

    it('ignores a report from any other window', async () => {
      const { frame } = await renderRunningFrame();
      post(window, { type: ARTIFACT_HEIGHT_MESSAGE_TYPE, height: 2400 });
      if (!frame.contentWindow) throw new Error('the outer frame has no window');
      post(frame.contentWindow, { type: ARTIFACT_HEIGHT_MESSAGE_TYPE, height: 2400 });
      expect(frame.style.height).toBe('');
    });

    it.each([
      ['another message type', { type: 'something-else', height: 2400 }],
      ['a non-numeric height', { type: ARTIFACT_HEIGHT_MESSAGE_TYPE, height: '2400' }],
      ['a zero height', { type: ARTIFACT_HEIGHT_MESSAGE_TYPE, height: 0 }],
      ['an infinite height', { type: ARTIFACT_HEIGHT_MESSAGE_TYPE, height: Number.POSITIVE_INFINITY }],
      ['a bare number', 2400],
    ])('ignores %s', async (_label, data) => {
      const { frame, artifactWindow } = await renderRunningFrame();
      post(artifactWindow, data);
      expect(frame.style.height).toBe('');
    });

    it('caps an oversized report so a runaway artifact cannot stretch the page without bound', async () => {
      const { frame, artifactWindow } = await renderRunningFrame();
      post(artifactWindow, { type: ARTIFACT_HEIGHT_MESSAGE_TYPE, height: 10_000_000 });
      expect(frame.style.height).toBe('100000px');
    });
  });
});
