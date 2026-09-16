import type { TocEntryResponse } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageTocColumns } from './page-toc-columns';

const TOC: TocEntryResponse[] = [
  { level: 1, text: 'A', anchorId: 'a' },
  { level: 1, text: 'B', anchorId: 'b' },
];

const shell = () => document.querySelector('[data-toc-columns]');
const contentColumn = () => screen.getByText('body').parentElement;

afterEach(cleanup);

describe('PageTocColumns', () => {
  it('draws the rail beside a prose-width content column', () => {
    render(
      <PageTocColumns toc={TOC} activeTocId={null} railActions={<button type="button">copy</button>}>
        <p>body</p>
      </PageTocColumns>,
    );

    expect(shell()?.getAttribute('data-toc-columns')).toBe('');
    expect(contentColumn()?.className).not.toContain('max-w-[var(--shell-pair)]');
    expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy();
  });

  // RFC-0020 — an artifact page's column takes the rail's place instead of
  // sitting beside an empty one.
  it('drops the rail and widens the content column to the pair when wide', () => {
    render(
      <PageTocColumns toc={TOC} activeTocId={null} railActions={<button type="button">copy</button>} wide>
        <p>body</p>
      </PageTocColumns>,
    );

    expect(shell()?.getAttribute('data-toc-columns')).toBe('wide');
    expect(contentColumn()?.className).toContain('min-[1280px]:max-w-[var(--shell-pair)]');
    // The left spacer and the content column only — no rail column.
    expect(shell()?.children).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'copy' })).toBeNull();
  });
});
