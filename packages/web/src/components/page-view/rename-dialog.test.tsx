import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenamePageResult, RenamePageVariables } from '@/lib/use-page-mutations';

const { mutateAsync, replace, usePageList, useRenamePage, useRenameSubtree } = vi.hoisted(() => ({
  mutateAsync: vi.fn<(variables: RenamePageVariables) => Promise<RenamePageResult>>(),
  replace: vi.fn(),
  usePageList: vi.fn(),
  useRenamePage: vi.fn(),
  useRenameSubtree: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/lib/notify', () => ({ notify: { info: vi.fn() } }));
vi.mock('@/lib/use-page-list', () => ({ usePageList }));
vi.mock('@/lib/use-page-mutations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-page-mutations')>('@/lib/use-page-mutations');
  return { ...actual, useRenamePage, useRenameSubtree };
});

import { RenameDialog } from './rename-dialog';

const page = {
  _id: 'page-1',
  path: '/docs/original',
  revision: { _id: 'revision-1', path: '/docs/original', body: 'body', format: 'markdown', createdAt: '2026-08-20T00:00:00.000Z' },
  creator: null,
  lastUpdateUser: null,
  commentCount: 0,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  likerCount: 0,
  seenUsersCount: 0,
} as PageWithRevision;

beforeEach(() => {
  mutateAsync.mockResolvedValue({ page: { ...page, path: '/docs/renamed' }, renamedCount: 1 });
  useRenamePage.mockReturnValue({ mutateAsync, isPending: false });
  useRenameSubtree.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  usePageList.mockReturnValue({ data: { pages: [] } });
});

describe('RenameDialog', () => {
  it('AC-17: sends a fresh idempotency key for each rename action', async () => {
    render(<RenameDialog page={page} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(m['page.rename.new_path']()), { target: { value: '/docs/renamed' } });
    const submit = screen.getByRole('button', { name: m['page.rename.submit']() });

    fireEvent.click(submit);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    fireEvent.click(submit);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));

    const firstKey = mutateAsync.mock.calls[0][0].idempotencyKey;
    const secondKey = mutateAsync.mock.calls[1][0].idempotencyKey;
    expect(firstKey).not.toBe(secondKey);
  });
});
