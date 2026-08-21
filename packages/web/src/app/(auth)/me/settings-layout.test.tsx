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

  // A successful callback redirect
  // (`?provider=…&link_completion=…`, both present) is the confirmation
  // dialog's own trigger, and it lives on the security tab.
  it('opens the security tab for a completion URL (?provider=&link_completion=, both present)', () => {
    searchParams.current = new URLSearchParams('provider=google&link_completion=abc123');
    renderLayout();

    expect(screen.getByText('SECURITY PANEL')).toBeVisible();
  });

  it('does NOT open the security tab when only ONE of provider/link_completion is present', () => {
    searchParams.current = new URLSearchParams('provider=google');
    renderLayout();
    expect(screen.getByText('PROFILE PANEL')).toBeVisible();

    cleanup();
    searchParams.current = new URLSearchParams('link_completion=abc123');
    renderLayout();
    expect(screen.getByText('PROFILE PANEL')).toBeVisible();
  });

  // A callback FAILURE redirect (`link=link_failed`, no completion code) also lands on the security tab.
  it('opens the security tab for a callback failure (?provider=&link=link_failed)', () => {
    searchParams.current = new URLSearchParams('provider=google&link=link_failed');
    renderLayout();

    expect(screen.getByText('SECURITY PANEL')).toBeVisible();
  });

  it('an explicit ?tab= wins over a completion URL', () => {
    searchParams.current = new URLSearchParams('tab=profile&provider=google&link_completion=abc123');
    renderLayout();

    expect(screen.getByText('PROFILE PANEL')).toBeVisible();
  });

  it('ignores an unknown ?tab= rather than showing nothing', () => {
    searchParams.current = new URLSearchParams('tab=made-up');
    renderLayout();

    expect(screen.getByText('PROFILE PANEL')).toBeVisible();
  });
});
