import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the tab the user arrives on is under test, so the two panels are
// plain markers and navigation is mocked.
const { searchParams } = vi.hoisted(() => ({ searchParams: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams.current }));

import { SettingsLayout } from './settings-layout';

const renderLayout = () => render(<SettingsLayout profileTab={<p>PROFILE PANEL</p>} securityTab={<p>SECURITY PANEL</p>} />);

beforeEach(() => {
  searchParams.current = new URLSearchParams();
});

afterEach(cleanup);

describe('SettingsLayout initial tab', () => {
  it('opens Profile on a plain visit', () => {
    renderLayout();

    expect(screen.getByText('PROFILE PANEL')).toBeVisible();
  });

  it('opens the tab named by ?tab=', () => {
    searchParams.current = new URLSearchParams('tab=security');
    renderLayout();

    expect(screen.getByText('SECURITY PANEL')).toBeVisible();
  });

  // The api's post-link redirect lands on /me?provider=…&link=…, and the
  // outcome it wants to show lives on the security tab. Defaulting to
  // Profile put "account linked" on a tab the user was not looking at.
  it.each(['linked', 'federated_identity_in_use', 'link_failed'])('opens the security tab when returning from a link flow (?link=%s)', (result) => {
    searchParams.current = new URLSearchParams(`provider=google&link=${result}`);
    renderLayout();

    expect(screen.getByText('SECURITY PANEL')).toBeVisible();
  });

  it('ignores an unknown ?tab= rather than showing nothing', () => {
    searchParams.current = new URLSearchParams('tab=made-up');
    renderLayout();

    expect(screen.getByText('PROFILE PANEL')).toBeVisible();
  });
});
