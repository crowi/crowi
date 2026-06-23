import { cleanup, render, screen } from '@testing-library/react';
import type { TocEntryResponse } from '@crowi/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { TocList } from './page-toc';

afterEach(() => {
  cleanup();
});

describe('TocList', () => {
  it('renders a plain heading label and a #anchorId href', () => {
    const toc: TocEntryResponse[] = [{ level: 2, text: 'Getting started', anchorId: 'getting-started' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Getting started' });
    expect(link.getAttribute('href')).toBe('#getting-started');
  });

  it('strips inline HTML from the displayed label while keeping href = #anchorId', () => {
    // `entry.text` is the RAW (as-authored) heading text including inline HTML;
    // `anchorId` is the server-side slug of the STRIPPED text. The TOC must
    // show the clean label but still link to the (already-clean) anchorId.
    const toc: TocEntryResponse[] = [{ level: 3, text: '<font color="1a73e8">Workspace の作成</font>', anchorId: 'workspace-の作成' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Workspace の作成' });
    // Visible label has no `<font …>` markup left.
    expect(link.textContent).toBe('Workspace の作成');
    expect(link.textContent).not.toContain('<font');
    // The `title` attr is stripped too.
    expect(link.getAttribute('title')).toBe('Workspace の作成');
    // href / anchor is taken verbatim from the server-generated anchorId.
    expect(link.getAttribute('href')).toBe('#workspace-の作成');
  });

  it('leaves an unknown tag-like token (List<int>) intact in the label', () => {
    const toc: TocEntryResponse[] = [{ level: 2, text: 'Using List<int> in C#', anchorId: 'using-listint-in-c' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Using List<int> in C#' });
    expect(link.textContent).toBe('Using List<int> in C#');
    expect(link.getAttribute('href')).toBe('#using-listint-in-c');
  });

  it('strips inline presentational tags the body renderer keeps (<strike>, <tt>)', () => {
    // These tags are rendered as elements in the body, so the TOC label must
    // strip them too (strip set ⊇ the body renderer inline allow-list).
    const toc: TocEntryResponse[] = [{ level: 2, text: '<strike>Old</strike> and <tt>code</tt>', anchorId: 'old-and-code' }];
    render(<TocList toc={toc} activeId={null} />);

    const link = screen.getByRole('link', { name: 'Old and code' });
    expect(link.textContent).toBe('Old and code');
    expect(link.getAttribute('href')).toBe('#old-and-code');
  });
});
