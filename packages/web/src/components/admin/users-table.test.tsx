import type { AdminPager, AdminUserListItem } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AC-10: the row-level affordances (linked-identity icon, disabled email
// action, per-provider unlink items) live here, not in the dialogs the
// sibling `user-action-dialogs.test.tsx` already covers. `useAuthProviders`
// is mocked wholesale (mirrors `linked-accounts-section.test.tsx`) so this
// stays a pure component test with no QueryClientProvider needed.
const { useAuthProviders } = vi.hoisted(() => ({ useAuthProviders: vi.fn() }));
vi.mock('@/lib/use-auth-providers', () => ({ useAuthProviders }));

import { UsersTable } from './users-table';

function makeUser(overrides: Partial<AdminUserListItem> = {}): AdminUserListItem {
  return {
    _id: 'u1',
    id: 'u1',
    username: 'dave',
    name: 'Dave',
    email: 'dave@example.com',
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    admin: false,
    linkedProviders: [],
    ...overrides,
  };
}

const PAGER: AdminPager = { page: 1, pagesCount: 1, pages: [1], total: 1, previous: null, previousDots: false, next: null, nextDots: false };

beforeEach(() => {
  // Radix dropdown primitives call these in jsdom, which lacks them.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};

  useAuthProviders.mockReturnValue({ data: [{ name: 'google', buttonLabel: 'Google' }] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the row's dotmenu for the (single) user rendered in the table. */
function openRowMenu() {
  const trigger = screen.getByLabelText(m['admin.users.action.menu_open']());
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

/** The badge wrapper around the linked-provider marks — reached via its sr-only label. */
function linkedIdentityBadge(providers: string): HTMLElement {
  const label = screen.getByText(m['admin.users.linked_identity_label']({ providers }));
  if (!label.parentElement) throw new Error('linked-identity badge has no wrapper element');
  return label.parentElement;
}

describe('UsersTable — linked-identity icon (AC-10)', () => {
  it('shows the linked-identity marker for a user with a federated identity', () => {
    render(<UsersTable users={[makeUser({ linkedProviders: ['google'] })]} pager={PAGER} onPageChange={vi.fn()} />);

    expect(screen.getByText(m['admin.users.linked_identity_label']({ providers: 'Google' }))).toBeInTheDocument();
  });

  it('shows nothing for a user with no linked identity', () => {
    render(<UsersTable users={[makeUser({ linkedProviders: [] })]} pager={PAGER} onPageChange={vi.fn()} />);

    expect(screen.queryByText(m['admin.users.linked_identity_label']({ providers: 'Google' }))).not.toBeInTheDocument();
  });

  it('falls back to the raw provider slug when the plugin is no longer installed', () => {
    render(<UsersTable users={[makeUser({ linkedProviders: ['saml'] })]} pager={PAGER} onPageChange={vi.fn()} />);

    expect(screen.getByText(m['admin.users.linked_identity_label']({ providers: 'saml' }))).toBeInTheDocument();
  });

  it("draws the provider's own brand mark instead of the generic link icon", () => {
    render(<UsersTable users={[makeUser({ linkedProviders: ['google'] })]} pager={PAGER} onPageChange={vi.fn()} />);

    const badge = linkedIdentityBadge('Google');
    expect(badge.querySelectorAll('svg')).toHaveLength(1);
    expect(badge.querySelector('.lucide-link-2')).not.toBeInTheDocument();
  });

  // A wrong logo is worse than a neutral one, so a provider we ship no mark
  // for keeps the generic link icon.
  it('keeps the generic link icon for a provider we ship no mark for', () => {
    render(<UsersTable users={[makeUser({ linkedProviders: ['saml'] })]} pager={PAGER} onPageChange={vi.fn()} />);

    expect(linkedIdentityBadge('saml').querySelector('.lucide-link-2')).toBeInTheDocument();
  });

  it('draws one mark per linked provider', () => {
    render(<UsersTable users={[makeUser({ linkedProviders: ['google', 'saml'] })]} pager={PAGER} onPageChange={vi.fn()} />);

    const badge = linkedIdentityBadge('Google, saml');
    expect(badge.querySelectorAll('svg')).toHaveLength(2);
    expect(badge.querySelectorAll('.lucide-link-2')).toHaveLength(1);
  });
});

describe('UsersTable — row menu on a linked user (AC-10)', () => {
  it('disables "Change email" with a hint, and does not fire onAction when clicked', () => {
    const onAction = vi.fn();
    render(<UsersTable users={[makeUser({ linkedProviders: ['google'] })]} pager={PAGER} onPageChange={vi.fn()} onAction={onAction} />);
    openRowMenu();

    const item = screen.getByRole('menuitem', { name: m['admin.users.action.update_email']() });
    expect(item).toHaveAttribute('title', m['admin.users.action.update_email_locked_hint']());
    expect(item).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(item);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('leaves "Change email" enabled for a user with no linked identity', () => {
    const onAction = vi.fn();
    render(<UsersTable users={[makeUser({ linkedProviders: [] })]} pager={PAGER} onPageChange={vi.fn()} onAction={onAction} />);
    openRowMenu();

    const item = screen.getByRole('menuitem', { name: m['admin.users.action.update_email']() });
    expect(item).not.toHaveAttribute('title');
    expect(item).not.toHaveAttribute('aria-disabled');

    fireEvent.click(item);
    expect(onAction).toHaveBeenCalledWith({ kind: 'update-email', user: expect.objectContaining({ _id: 'u1' }) });
  });

  it('offers one "Unlink" item per linked provider, each firing onAction with its own provider + label', () => {
    const onAction = vi.fn();
    const user = makeUser({ linkedProviders: ['google', 'saml'] });
    render(<UsersTable users={[user]} pager={PAGER} onPageChange={vi.fn()} onAction={onAction} />);
    openRowMenu();

    const googleItem = screen.getByRole('menuitem', { name: m['admin.users.action.unlink_identity']({ provider: 'Google' }) });
    const samlItem = screen.getByRole('menuitem', { name: m['admin.users.action.unlink_identity']({ provider: 'saml' }) });
    expect(googleItem).toBeInTheDocument();
    expect(samlItem).toBeInTheDocument();

    fireEvent.click(googleItem);
    expect(onAction).toHaveBeenCalledWith({ kind: 'unlink-identity', user, provider: 'google', providerLabel: 'Google' });
  });

  it('renders no "Unlink" item for a user with no linked identity', () => {
    render(<UsersTable users={[makeUser({ linkedProviders: [] })]} pager={PAGER} onPageChange={vi.fn()} onAction={vi.fn()} />);
    openRowMenu();

    expect(screen.queryByRole('menuitem', { name: m['admin.users.action.unlink_identity']({ provider: 'Google' }) })).not.toBeInTheDocument();
  });

  it("disables the operating admin's own unlink item, so a passwordless admin cannot lock themselves out from the row menu", () => {
    const onAction = vi.fn();
    const user = makeUser({ _id: 'admin1', id: 'admin1', linkedProviders: ['google'] });
    render(<UsersTable users={[user]} pager={PAGER} onPageChange={vi.fn()} onAction={onAction} currentUserId="admin1" />);
    openRowMenu();

    const item = screen.getByRole('menuitem', { name: m['admin.users.action.unlink_identity']({ provider: 'Google' }) });
    expect(item).toHaveAttribute('title', m['admin.users.action.self_disabled_hint']());
    expect(item).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(item);
    expect(onAction).not.toHaveBeenCalled();
  });
});
