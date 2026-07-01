import { describe, expect, it } from 'vitest';
import { initialLiveSyncBannerState, isDisplayingOld, type LiveSyncBannerState, reduceLiveSyncBanner } from './live-sync-banner-state';

const showingLatest: LiveSyncBannerState = { kind: 'showing-latest', editorDisplayName: 'Bob' };
const showingOld: LiveSyncBannerState = { kind: 'showing-old', editorDisplayName: 'Bob' };
const showingLatestAgain: LiveSyncBannerState = { kind: 'showing-latest-again', editorDisplayName: 'Carol' };

describe('reduceLiveSyncBanner', () => {
  it('starts hidden', () => {
    expect(initialLiveSyncBannerState).toEqual({ kind: 'hidden' });
  });

  it('a forward auto-swap moves hidden → showing-latest with the editor name', () => {
    const r = reduceLiveSyncBanner(initialLiveSyncBannerState, { type: 'swapped', editorDisplayName: 'Bob' });
    expect(r).toEqual({ kind: 'showing-latest', editorDisplayName: 'Bob' });
  });

  it('a later swap keeps showing-latest and refreshes the editor name', () => {
    const r = reduceLiveSyncBanner(showingLatest, { type: 'swapped', editorDisplayName: 'Dana' });
    expect(r).toEqual({ kind: 'showing-latest', editorDisplayName: 'Dana' });
  });

  it('read-old moves showing-latest → showing-old, preserving the editor name', () => {
    const r = reduceLiveSyncBanner(showingLatest, { type: 'read-old' });
    expect(r).toEqual({ kind: 'showing-old', editorDisplayName: 'Bob' });
  });

  it('read-old is a no-op unless showing-latest', () => {
    expect(reduceLiveSyncBanner(showingOld, { type: 'read-old' })).toBe(showingOld);
    expect(reduceLiveSyncBanner(initialLiveSyncBannerState, { type: 'read-old' })).toBe(initialLiveSyncBannerState);
  });

  it('a newer save while showing-old escalates to showing-latest-again with the new editor', () => {
    const r = reduceLiveSyncBanner(showingOld, { type: 'newer-while-old', editorDisplayName: 'Carol' });
    expect(r).toEqual({ kind: 'showing-latest-again', editorDisplayName: 'Carol' });
  });

  it('a still-newer save while showing-latest-again updates to the newest editor', () => {
    const r = reduceLiveSyncBanner(showingLatestAgain, { type: 'newer-while-old', editorDisplayName: 'Erin' });
    expect(r).toEqual({ kind: 'showing-latest-again', editorDisplayName: 'Erin' });
  });

  it('newer-while-old is a no-op while displaying the latest (cache is not behind)', () => {
    expect(reduceLiveSyncBanner(showingLatest, { type: 'newer-while-old', editorDisplayName: 'Carol' })).toBe(showingLatest);
  });

  it('show-latest returns showing-old → showing-latest', () => {
    expect(reduceLiveSyncBanner(showingOld, { type: 'show-latest' })).toEqual({ kind: 'showing-latest', editorDisplayName: 'Bob' });
  });

  it('show-latest returns showing-latest-again → showing-latest', () => {
    expect(reduceLiveSyncBanner(showingLatestAgain, { type: 'show-latest' })).toEqual({ kind: 'showing-latest', editorDisplayName: 'Carol' });
  });

  it('show-latest is a no-op while already displaying the latest', () => {
    expect(reduceLiveSyncBanner(showingLatest, { type: 'show-latest' })).toBe(showingLatest);
  });

  it('dismiss hides from any state', () => {
    for (const state of [initialLiveSyncBannerState, showingLatest, showingOld, showingLatestAgain]) {
      expect(reduceLiveSyncBanner(state, { type: 'dismiss' })).toEqual({ kind: 'hidden' });
    }
  });
});

describe('isDisplayingOld', () => {
  it('is true only while showing the old body (showing-old / showing-latest-again)', () => {
    expect(isDisplayingOld(initialLiveSyncBannerState)).toBe(false);
    expect(isDisplayingOld(showingLatest)).toBe(false);
    expect(isDisplayingOld(showingOld)).toBe(true);
    expect(isDisplayingOld(showingLatestAgain)).toBe(true);
  });
});
