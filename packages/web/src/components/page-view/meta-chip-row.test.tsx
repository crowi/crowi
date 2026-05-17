import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { PageWithRevision } from '@crowi/api-contract';

// Mock the data hooks so the row is pure UI — no react-query, no API.
const { useBacklinks } = vi.hoisted(() => ({ useBacklinks: vi.fn() }));
const { useLikers } = vi.hoisted(() => ({ useLikers: vi.fn() }));
const { useSeenUsers } = vi.hoisted(() => ({ useSeenUsers: vi.fn() }));
vi.mock('@/lib/use-backlinks', () => ({ useBacklinks }));
vi.mock('@/lib/use-likers', () => ({ useLikers, likersKeys: { pagePrefix: (id: string) => ['likers', id] } }));
vi.mock('@/lib/use-seen', () => ({ useSeenUsers }));

import { MetaChipRow } from './meta-chip-row';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-1',
    path: '/docs/example',
    revision: {
      _id: 'rev-1',
      path: '/docs/example',
      body: '# hi',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
      author: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    },
    creator: null,
    lastUpdateUser: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    ...overrides,
  } as PageWithRevision;
}

beforeEach(() => {
  useBacklinks.mockReturnValue({ data: { backlinks: [], hasNext: false } });
  useLikers.mockReturnValue({ data: { users: [], totalCount: 0 }, isLoading: false });
  useSeenUsers.mockReturnValue({ data: { seenUsers: [], seenUsersCount: 0 }, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MetaChipRow', () => {
  it('renders the static author + last-updated elements', () => {
    render(<MetaChipRow page={makePage()} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    // last-updated time chip carries the localized "... に更新" string.
    expect(screen.getByText(/に更新/)).toBeTruthy();
  });

  it('renders four meta chips (like / view / comment / backlink)', () => {
    const page = makePage({ likerCount: 2, seenUsersCount: 3, commentCount: 4 });
    useBacklinks.mockReturnValue({ data: { backlinks: [{ _id: 'b1' }, { _id: 'b2' }], hasNext: false } });
    render(<MetaChipRow page={page} />);

    // Active chips are buttons; with all four counts > 0 there are four.
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('greys out a zero-count chip as non-interactive', () => {
    // likerCount 0 → the like chip is disabled (not a button);
    // backlinks default to 0 via the beforeEach mock.
    render(<MetaChipRow page={makePage({ likerCount: 0, seenUsersCount: 5, commentCount: 1 })} />);
    // 0 likes + 0 backlinks → 2 active chips (view, comment).
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('opens the "Liked by" modal when the like chip is clicked', () => {
    render(<MetaChipRow page={makePage({ likerCount: 1 })} />);
    const likeChip = screen.getByRole('button', { name: /いいね/ });
    fireEvent.click(likeChip);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('いいねした人')).toBeTruthy();
  });

  it('opens the "Seen by" modal when the view chip is clicked', () => {
    render(<MetaChipRow page={makePage({ seenUsersCount: 2 })} />);
    const viewChip = screen.getByRole('button', { name: /閲覧/ });
    fireEvent.click(viewChip);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('閲覧者一覧')).toBeTruthy();
  });

  it('scrolls to the comments heading when the comment chip is clicked', () => {
    const heading = document.createElement('h2');
    heading.id = 'comments-heading';
    heading.scrollIntoView = vi.fn();
    heading.focus = vi.fn();
    document.body.appendChild(heading);

    render(<MetaChipRow page={makePage({ commentCount: 3 })} />);
    fireEvent.click(screen.getByRole('button', { name: /コメント/ }));

    expect(heading.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(heading.focus).toHaveBeenCalled();
    document.body.removeChild(heading);
  });
});
