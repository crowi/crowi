/**
 * feature-live-page-content-sync — the read-side soft-refresh banner
 * state machine. A pure reducer (mirroring `collab-status-toast.ts`) so
 * the transitions are unit-testable without React.
 *
 * The banner state is intentionally decoupled from `isStalePageRevision`
 * and the `['page']` query cache: the cache always holds the *latest*
 * revision, while "reading the previous version" is a purely local
 * PageView view-state. Which body is shown is derived from
 * {@link isDisplayingOld}; the presence WebSocket stays connected in
 * every non-hidden state so the `showing-old → showing-latest-again`
 * transition is always reachable.
 *
 * States (all non-hidden carry the display name of the relevant editor):
 *   - `hidden`               — no banner.
 *   - `showing-latest`       — the body was auto-swapped to the latest
 *                              revision; offers "read the previous version".
 *   - `showing-old`          — the reader chose to view the pre-swap
 *                              version; the cache still holds the latest.
 *                              Offers "back to the latest".
 *   - `showing-latest-again` — while showing the old version a *newer*
 *                              save arrived; offers "show the latest"
 *                              (which fetches + advances the cache).
 */
export type LiveSyncBannerState =
  | { kind: 'hidden' }
  | { kind: 'showing-latest'; editorDisplayName: string }
  | { kind: 'showing-old'; editorDisplayName: string }
  | { kind: 'showing-latest-again'; editorDisplayName: string };

export type LiveSyncBannerEvent =
  /** A forward auto-swap to the latest revision completed. */
  | { type: 'swapped'; editorDisplayName: string }
  /** The reader clicked "read the previous version" (no cache write). */
  | { type: 'read-old' }
  /** A newer save arrived while the reader is viewing the old version. */
  | { type: 'newer-while-old'; editorDisplayName: string }
  /** The reader clicked "show the latest" / "back to the latest". */
  | { type: 'show-latest' }
  /** The reader dismissed the banner, or the socket closed / navigated. */
  | { type: 'dismiss' };

export const initialLiveSyncBannerState: LiveSyncBannerState = { kind: 'hidden' };

/**
 * Whether the reader is currently looking at the *old* (pre-swap) body.
 * True for both `showing-old` and `showing-latest-again` — in both the
 * PageView renders the local snapshot, not the (latest) cache.
 */
export function isDisplayingOld(state: LiveSyncBannerState): boolean {
  return state.kind === 'showing-old' || state.kind === 'showing-latest-again';
}

export function reduceLiveSyncBanner(state: LiveSyncBannerState, event: LiveSyncBannerEvent): LiveSyncBannerState {
  switch (event.type) {
    case 'dismiss':
      return { kind: 'hidden' };
    case 'swapped':
      // A forward auto-swap only fires while displaying the latest, so
      // this always lands on `showing-latest` with the newest editor.
      return { kind: 'showing-latest', editorDisplayName: event.editorDisplayName };
    case 'read-old':
      // Only meaningful from `showing-latest`; ignore otherwise.
      return state.kind === 'showing-latest' ? { kind: 'showing-old', editorDisplayName: state.editorDisplayName } : state;
    case 'newer-while-old':
      // A newer save while the old body is shown escalates the banner but
      // never touches the cache. No-op when already displaying the latest.
      return state.kind === 'showing-old' || state.kind === 'showing-latest-again'
        ? { kind: 'showing-latest-again', editorDisplayName: event.editorDisplayName }
        : state;
    case 'show-latest':
      // Return to the latest view. Valid from either old-displaying state;
      // the PageView fetches + advances the cache first when needed.
      return state.kind === 'showing-old' || state.kind === 'showing-latest-again'
        ? { kind: 'showing-latest', editorDisplayName: state.editorDisplayName }
        : state;
    default:
      return state;
  }
}
