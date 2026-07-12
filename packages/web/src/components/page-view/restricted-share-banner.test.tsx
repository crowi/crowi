import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum, PageStatusEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPageShareUrl } from '@/lib/build-page-share-url';
import { RestrictedShareBanner, shouldShowRestrictedShareBanner } from './restricted-share-banner';

const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));

// Only needed by the AC7-parity describe block below (rendered alongside
// `RestrictedShareBanner` to prove they build the identical share URL).
import { LinkSharePopover } from './link-share-popover';

afterEach(() => {
  cleanup();
});

type PredicatePage = Pick<PageWithRevision, 'grant' | 'status'>;

function page(overrides: Partial<PredicatePage> = {}): PredicatePage {
  return { grant: PageGrantEnum.RESTRICTED, status: undefined, ...overrides };
}

describe('shouldShowRestrictedShareBanner', () => {
  // GRANT_RESTRICTED x { status missing (undefined) → show, status null
  // (the production shape returned by the API for a page that never had a
  // status written) → show, published → show, wip → hide, deprecated →
  // hide }. draft / deleted are excluded upstream (PageView's `!isDraft` /
  // deleted early-return), not by this predicate, but are covered here too
  // via the isDraft / isStaleRevision flags this function does take.
  it.each([
    ['missing status (undefined)', undefined, true],
    ['null status', null, true],
    ['published', PageStatusEnum.PUBLISHED, true],
    ['wip', PageStatusEnum.WIP, false],
    ['deprecated', PageStatusEnum.DEPRECATED, false],
  ] as const)('GRANT_RESTRICTED with %s status → %s', (_label, status, expected) => {
    expect(shouldShowRestrictedShareBanner(page({ status }), { isStaleRevision: false, isDraft: false })).toBe(expected);
  });

  it.each([
    ['PUBLIC', PageGrantEnum.PUBLIC],
    ['SPECIFIED', PageGrantEnum.SPECIFIED],
    ['OWNER', PageGrantEnum.OWNER],
  ] as const)('grant %s never shows the banner regardless of status', (_label, grant) => {
    expect(shouldShowRestrictedShareBanner(page({ grant, status: PageStatusEnum.PUBLISHED }), { isStaleRevision: false, isDraft: false })).toBe(false);
  });

  it('hides for a stale (historical) revision view even when otherwise eligible', () => {
    expect(shouldShowRestrictedShareBanner(page({ status: PageStatusEnum.PUBLISHED }), { isStaleRevision: true, isDraft: false })).toBe(false);
  });

  it('hides for a draft view even when otherwise eligible', () => {
    expect(shouldShowRestrictedShareBanner(page({ status: PageStatusEnum.PUBLISHED }), { isStaleRevision: false, isDraft: true })).toBe(false);
  });
});

describe('RestrictedShareBanner', () => {
  const pageId = 'page-restricted-1';

  it('renders the invite title and body copy', () => {
    render(<RestrictedShareBanner pageId={pageId} />);
    expect(screen.getByText(m['page.share.restricted_banner_title']())).toBeTruthy();
    expect(screen.getByText(m['page.share.restricted_banner_body']())).toBeTruthy();
  });

  it('displays the same share URL that LinkSharePopover would build (buildPageShareUrl parity)', () => {
    render(<RestrictedShareBanner pageId={pageId} />);
    const input = screen.getByDisplayValue(buildPageShareUrl(pageId)) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });

  it('copies the displayed URL to the clipboard when the copy button is pressed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<RestrictedShareBanner pageId={pageId} />);
    fireEvent.click(screen.getByRole('button', { name: m['page.share.copy']() }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(buildPageShareUrl(pageId)));
  });

  it('has no dismiss / close UI (the banner is permanent, per spec)', () => {
    render(<RestrictedShareBanner pageId={pageId} />);
    expect(screen.queryByRole('button', { name: /dismiss|close/i })).toBeNull();
    // Only the one copy button — no second (dismiss) control.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('RestrictedShareBanner vs. LinkSharePopover — same URL (AC7)', () => {
  const pageId = 'page-restricted-parity-1';

  function makeSharePage(): PageWithRevision {
    return {
      _id: pageId,
      path: '/docs/guide/example',
      revision: {
        _id: 'rev-1',
        path: '/docs/guide/example',
        body: '# hi',
        format: 'markdown',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      creator: null,
      lastUpdateUser: null,
      commentCount: 0,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
      likerCount: 0,
      seenUsersCount: 0,
    } as PageWithRevision;
  }

  beforeEach(() => {
    useAppInfo.mockReturnValue({ data: { title: 'Crowi' } });
    // Radix dropdown primitives call these in jsdom, which lacks them.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
  });

  // AC7 asks specifically that the banner's URL match what `LinkSharePopover`
  // shares — not merely that both happen to equal a value the test computes
  // independently with `buildPageShareUrl`. Rendering both components at
  // once from the same `pageId`/`page` fixture and reading LinkSharePopover's
  // OWN auto-copy-on-open behavior (it copies `idUrl` to the clipboard as
  // soon as the dropdown opens) proves the two components' internally
  // computed URLs are identical, not just independently correct.
  it('LinkSharePopover copies exactly the URL RestrictedShareBanner displays, for the same page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    render(
      <>
        <RestrictedShareBanner pageId={pageId} />
        <LinkSharePopover page={makeSharePage()} />
      </>,
      { wrapper },
    );

    const bannerUrl = (screen.getByDisplayValue(buildPageShareUrl(pageId)) as HTMLInputElement).value;

    // Radix opens the dropdown on pointerdown; jsdom needs an explicit event.
    const trigger = screen.getByLabelText(m['page.share.aria_open']());
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    fireEvent.click(trigger);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(bannerUrl));
  });
});
