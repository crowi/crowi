import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PresenceViewer } from '@crowi/api-contract';
import type { PresenceStatus, UsePresenceResult } from '@/lib/use-presence';
import { LivePresenceRow } from './live-presence-row';

// `LivePresenceRow` now takes the `usePresence` result as a prop (hoisted
// to the parent so the expanded + compact rows share one WebSocket), so
// the test feeds it presence values directly — no hook mock required.

function viewer(userId: string, overrides: Partial<PresenceViewer> = {}): PresenceViewer {
  return {
    userId,
    username: userId,
    displayName: `User ${userId}`,
    avatarUrl: null,
    isEditing: false,
    joinedAt: 1_000,
    ...overrides,
  };
}

function makePresence(viewers: PresenceViewer[], selfUserId: string | null, status: PresenceStatus = 'connected'): UsePresenceResult {
  return { viewers, selfUserId, status };
}

afterEach(() => {
  cleanup();
});

describe('LivePresenceRow', () => {
  // The row wrapper always renders (it reserves a fixed height to avoid
  // layout shift); only its *content* is conditional.
  it('reserves the row but shows no content when the only viewer is the current user', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me')], 'me')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBe(0);
  });

  it('reserves the row but shows no content when there are no viewers at all', () => {
    render(<LivePresenceRow presence={makePresence([], 'me')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBe(0);
  });

  it('reserves the row but shows no content when the presence WebSocket is in error state', () => {
    // Even with other viewers present, an error status hides the
    // content so the rest of the page degrades gracefully.
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice')], 'me', 'error')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBe(0);
  });

  it('renders content in the row when another viewer is present', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice')], 'me')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBeGreaterThan(0);
  });

  it('renders the editing badge for a viewer with the editor open', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice', { isEditing: true })], 'me')} />);
    // The ✏️ corner badge is the role="img" element styled bg-primary;
    // its accessible name embeds the editing user's display name.
    const badges = Array.from(document.querySelectorAll<HTMLElement>('[role="img"].bg-primary'));
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((b) => /User alice/.test(b.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('renders no editing badge when nobody is editing', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice')], 'me')} />);
    expect(document.querySelector('[role="img"].bg-primary')).toBeNull();
  });

  it('folds surplus viewers into a [+N] overflow button', () => {
    // 5 inline avatars max → 8 viewers leaves 3 in overflow.
    const viewers = ['me', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => viewer(id));
    render(<LivePresenceRow presence={makePresence(viewers, 'me')} />);
    // The overflow trigger is labelled with the hidden count.
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('does not render a [+N] button when viewers fit inline', () => {
    const viewers = ['me', 'a', 'b'].map((id) => viewer(id));
    render(<LivePresenceRow presence={makePresence(viewers, 'me')} />);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });
});
