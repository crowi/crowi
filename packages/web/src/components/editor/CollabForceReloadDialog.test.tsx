import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { CollabForceReloadDialog } from './CollabForceReloadDialog';

afterEach(() => {
  cleanup();
});

describe('CollabForceReloadDialog', () => {
  it('renders nothing visible when open is false', () => {
    render(<CollabForceReloadDialog open={false} />);
    // Radix AlertDialog hides content when closed; the title should
    // not be in the document.
    expect(screen.queryByText(/external|外部/i)).toBeNull();
  });

  it('renders the title, description, and action when open', () => {
    render(<CollabForceReloadDialog open={true} reason="admin-edit" />);
    // We assert the action button is present via its accessible role
    // — text content depends on the locale resolved at test time.
    const action = screen.getByRole('button');
    expect(action).toBeDefined();
    expect(action.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('fires onReload when the action button is clicked', () => {
    const onReload = vi.fn();
    render(<CollabForceReloadDialog open={true} onReload={onReload} />);

    const action = screen.getByRole('button');
    act(() => {
      action.click();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('includes the reason text in the rendered description', () => {
    render(<CollabForceReloadDialog open={true} reason="yjs-state-corrupted" />);
    // The description renderer interpolates {reason}; we only assert
    // the reason string is present so we don't lock in the surrounding
    // i18n wording.
    expect(screen.getByText(/yjs-state-corrupted/)).toBeDefined();
  });
});
