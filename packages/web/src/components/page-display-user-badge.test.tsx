import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarImageMockModule } from '@/lib/test-utils/mocks';
import { PageDisplayUserBadge } from './page-display-user-badge';

// See avatarImageMockModule (test-utils/mocks.ts) for why AvatarImage is
// stubbed (so the no-image case still exercises "no <img> in the tree").
// Same technique as `user-avatar.test.tsx`.
vi.mock('@/components/ui/avatar', async (importOriginal) => avatarImageMockModule(await importOriginal<typeof import('@/components/ui/avatar')>()));

type BadgeUser = ComponentProps<typeof PageDisplayUserBadge>['user'];

const HEX = 'e'.repeat(24);

function makeUser(image: string | null): BadgeUser {
  return { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', image, createdAt: '2026-01-01T00:00:00.000Z' };
}

afterEach(() => {
  cleanup();
});

describe('PageDisplayUserBadge — legacy attachment URL canonicalization (feature-api-v2-path-removal Phase 3)', () => {
  it('passes through a current-prefix image untouched', () => {
    render(<PageDisplayUserBadge user={makeUser(`/api/attachments/${HEX}`)} />);
    const img = screen.getByRole('img', { name: 'Alice' });
    expect(img.getAttribute('src')).toBe(`/api/attachments/${HEX}`);
  });

  it('canonicalizes a legacy /api/v2/attachments/by-key/... image', () => {
    render(<PageDisplayUserBadge user={makeUser('/api/v2/attachments/by-key/user%2Favatar.png')} />);
    const img = screen.getByRole('img', { name: 'Alice' });
    expect(img.getAttribute('src')).toBe('/api/attachments/by-key/user%2Favatar.png');
  });

  it('does not render an <img> when image is unset (unchanged fallback behaviour)', () => {
    render(<PageDisplayUserBadge user={makeUser(null)} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});
