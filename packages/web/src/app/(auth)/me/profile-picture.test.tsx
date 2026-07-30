import type { UserProfileResponse } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarImageMockModule } from '@/lib/test-utils/mocks';
import { ProfilePicture } from './profile-picture';

// `useUploadPicture`/`useDeletePicture` wrap `useMutation` — this test never
// triggers an upload/delete, so a minimal stub (never called) is enough.
vi.mock('@/lib/use-profile', () => ({
  useUploadPicture: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeletePicture: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// See avatarImageMockModule (test-utils/mocks.ts) for why AvatarImage is
// stubbed. Same technique as `user-avatar.test.tsx` / `page-display-user-badge.test.tsx`.
vi.mock('@/components/ui/avatar', async (importOriginal) => avatarImageMockModule(await importOriginal<typeof import('@/components/ui/avatar')>()));

const HEX = 'f'.repeat(24);

function makeProfile(image: string | null): UserProfileResponse {
  return {
    id: 'u1',
    username: 'dave',
    name: 'Dave',
    email: 'dave@example.com',
    lang: 'en',
    theme: 'system',
    image,
    hasPassword: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
});

describe('ProfilePicture — legacy attachment URL canonicalization (feature-api-v2-path-removal Phase 3)', () => {
  it('passes through a current-prefix profile.image untouched', () => {
    render(<ProfilePicture profile={makeProfile(`/api/attachments/${HEX}`)} />);
    const img = screen.getByRole('img', { name: 'Dave' });
    expect(img.getAttribute('src')).toBe(`/api/attachments/${HEX}`);
  });

  it('canonicalizes a legacy /api/v2/attachments/by-key/... profile.image', () => {
    render(<ProfilePicture profile={makeProfile('/api/v2/attachments/by-key/user%2Favatar.png')} />);
    const img = screen.getByRole('img', { name: 'Dave' });
    expect(img.getAttribute('src')).toBe('/api/attachments/by-key/user%2Favatar.png');
  });

  it('does not render an <img> when profile.image is unset (unchanged fallback behaviour)', () => {
    render(<ProfilePicture profile={makeProfile(null)} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});
