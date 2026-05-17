import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PresenceViewer } from '@crowi/api-contract';
import type { PresenceStatus } from '@/lib/use-presence';

// Mock the presence hook so the component test is pure UI — no WS,
// no token fetch, no timers.
const { usePresence } = vi.hoisted(() => ({ usePresence: vi.fn() }));
vi.mock('@/lib/use-presence', () => ({ usePresence }));

import { LivePresenceRow } from './live-presence-row';

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

function mockPresence(viewers: PresenceViewer[], selfUserId: string | null, status: PresenceStatus = 'connected') {
  usePresence.mockReturnValue({ viewers, selfUserId, status });
}

beforeEach(() => {
  usePresence.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('LivePresenceRow', () => {
  it('hides the row when the only viewer is the current user', () => {
    mockPresence([viewer('me')], 'me');
    render(<LivePresenceRow pageId="page-1" />);
    expect(screen.queryByTestId('live-presence-row')).toBeNull();
  });

  it('hides the row when there are no viewers at all', () => {
    mockPresence([], 'me');
    render(<LivePresenceRow pageId="page-1" />);
    expect(screen.queryByTestId('live-presence-row')).toBeNull();
  });

  it('hides the row when the presence WebSocket is in error state', () => {
    // Even with other viewers present, an error status hides the row
    // so the rest of the page degrades gracefully.
    mockPresence([viewer('me'), viewer('alice')], 'me', 'error');
    render(<LivePresenceRow pageId="page-1" />);
    expect(screen.queryByTestId('live-presence-row')).toBeNull();
  });

  it('renders the row when another viewer is present', () => {
    mockPresence([viewer('me'), viewer('alice')], 'me');
    render(<LivePresenceRow pageId="page-1" />);
    expect(screen.getByTestId('live-presence-row')).toBeTruthy();
  });

  it('renders the editing badge for a viewer with the editor open', () => {
    mockPresence([viewer('me'), viewer('alice', { isEditing: true })], 'me');
    render(<LivePresenceRow pageId="page-1" />);
    // The ✏️ corner badge is the role="img" element styled bg-primary;
    // its accessible name embeds the editing user's display name.
    const badges = Array.from(document.querySelectorAll<HTMLElement>('[role="img"].bg-primary'));
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((b) => /User alice/.test(b.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('renders no editing badge when nobody is editing', () => {
    mockPresence([viewer('me'), viewer('alice')], 'me');
    render(<LivePresenceRow pageId="page-1" />);
    expect(document.querySelector('[role="img"].bg-primary')).toBeNull();
  });

  it('folds surplus viewers into a [+N] overflow button', () => {
    // 5 inline avatars max → 8 viewers leaves 3 in overflow.
    const viewers = ['me', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => viewer(id));
    mockPresence(viewers, 'me');
    render(<LivePresenceRow pageId="page-1" />);
    // The overflow trigger is labelled with the hidden count.
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('does not render a [+N] button when viewers fit inline', () => {
    const viewers = ['me', 'a', 'b'].map((id) => viewer(id));
    mockPresence(viewers, 'me');
    render(<LivePresenceRow pageId="page-1" />);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });
});
