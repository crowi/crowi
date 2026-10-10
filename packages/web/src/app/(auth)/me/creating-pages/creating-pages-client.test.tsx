import type { DraftSummary } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextLinkMockModule } from '@/lib/test-utils/mocks';

/**
 * "Pages you're creating": each row's path link and edit icon depend on the
 * draft's content type. A Markdown draft opens the editor; an artifact draft
 * links to its page view and offers no editor entry. A response from an older
 * server has no `contentType` and is Markdown.
 */
const { useDrafts, push } = vi.hoisted(() => ({ useDrafts: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/use-drafts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-drafts')>('@/lib/use-drafts');
  return { ...actual, useDrafts, useCancelDraft: () => ({ mutate: vi.fn(), isPending: false }) };
});
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => nextLinkMockModule());
vi.mock('@/components/create-page/create-page-dialog', () => ({ CreatePageDialog: () => null }));

import { CreatingPagesClient } from './creating-pages-client';

const draft = (overrides: Partial<DraftSummary>): DraftSummary => ({
  pageId: 'd1',
  path: '/notes/draft one',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  ...overrides,
});

const serve = (drafts: DraftSummary[]) => useDrafts.mockReturnValue({ data: { drafts }, isLoading: false, isError: false });
const editIcon = () => screen.queryByRole('button', { name: m['creating_pages.action_edit']() });

afterEach(() => {
  cleanup();
  useDrafts.mockReset();
  push.mockReset();
});

describe('CreatingPagesClient — draft rows (artifact-edit-guard, AC-01)', () => {
  it('a Markdown draft: the path links to the editor and the edit icon is shown', () => {
    serve([draft({ contentType: 'markdown' })]);
    render(<CreatingPagesClient />);
    expect(screen.getByTitle('/notes/draft one').getAttribute('href')).toBe('/_edit?page_id=d1');
    expect(editIcon()).not.toBeNull();
    editIcon()?.click();
    expect(push).toHaveBeenCalledWith('/_edit?page_id=d1');
  });

  it('an artifact draft: the path links to the display URL and there is no edit icon, while cancel stays', () => {
    serve([draft({ contentType: 'artifact' })]);
    render(<CreatingPagesClient />);
    expect(screen.getByTitle('/notes/draft one').getAttribute('href')).toBe('/notes/draft+one');
    expect(editIcon()).toBeNull();
    expect(screen.getByRole('button', { name: m['creating_pages.action_cancel']() })).toBeTruthy();
  });

  it('a row from an older server without contentType keeps the Markdown behaviour', () => {
    serve([draft({})]);
    render(<CreatingPagesClient />);
    expect(screen.getByTitle('/notes/draft one').getAttribute('href')).toBe('/_edit?page_id=d1');
    expect(editIcon()).not.toBeNull();
  });
});
