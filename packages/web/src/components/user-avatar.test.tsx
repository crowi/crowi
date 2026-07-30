import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarImageMockModule } from '@/lib/test-utils/mocks';
import { UserAvatar } from './user-avatar';

// See avatarImageMockModule (test-utils/mocks.ts) for why AvatarImage is
// stubbed.
vi.mock('@/components/ui/avatar', async (importOriginal) => avatarImageMockModule(await importOriginal<typeof import('@/components/ui/avatar')>()));

const HEX = 'd'.repeat(24);

afterEach(() => {
  cleanup();
});

describe('UserAvatar — legacy attachment URL canonicalization (feature-api-v2-path-removal Phase 3)', () => {
  it('passes through a current-prefix user.image untouched', () => {
    render(<UserAvatar user={{ username: 'alice', name: 'Alice', image: `/api/attachments/${HEX}` }} />);
    const img = screen.getByRole('img', { name: 'Alice' });
    expect(img.getAttribute('src')).toBe(`/api/attachments/${HEX}`);
  });

  it('canonicalizes a legacy /api/v2/attachments/by-key/... user.image', () => {
    render(<UserAvatar user={{ username: 'bob', name: 'Bob', image: '/api/v2/attachments/by-key/user%2Favatar.png' }} />);
    const img = screen.getByRole('img', { name: 'Bob' });
    expect(img.getAttribute('src')).toBe('/api/attachments/by-key/user%2Favatar.png');
  });

  it('leaves the initials fallback unchanged when user.image is unset', () => {
    const { container } = render(<UserAvatar user={{ username: 'carol', name: 'Carol' }} />);
    // No AvatarImage is rendered at all (UserAvatar's own `user.image ?`
    // guard) — query the HTML <img> tag specifically, not `role="img"`,
    // since the BoringAvatar fallback SVG also carries `role="img"`.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByLabelText('Carol')).toBeTruthy();
  });
});
