import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyPageMarkdownButton } from './copy-page-markdown-button';

function makePage(body: string | undefined): PageWithRevision {
  return {
    _id: 'page-1',
    path: '/docs/guide',
    revision: body === undefined ? undefined : { _id: 'rev-1', path: '/docs/guide', body, format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z' },
    creator: null,
    lastUpdateUser: null,
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
  } as PageWithRevision;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CopyPageMarkdownButton', () => {
  it("puts the page's markdown body on the clipboard and confirms on the button itself", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CopyPageMarkdownButton page={makePage('# Title\n\nbody text')} />);
    fireEvent.click(screen.getByRole('button', { name: m['page.action_copy_markdown']() }));

    expect(writeText).toHaveBeenCalledWith('# Title\n\nbody text');
    expect(await screen.findByRole('button', { name: m['page.markdown_copied']() })).toBeInTheDocument();
  });

  // A button that copies nothing would claim success over an empty
  // clipboard write — the dotmenu action refuses the same case.
  it('renders nothing when the page has no body to copy', () => {
    const { container } = render(<CopyPageMarkdownButton page={makePage('')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the page has no revision at all', () => {
    const { container } = render(<CopyPageMarkdownButton page={makePage(undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });
});
