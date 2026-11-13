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

  // The portal listing shares this component, so the full-width mode is opt-in.
  it('is not a reading-width scope unless the host opts in', () => {
    render(
      <PageTocColumns toc={TOC} activeTocId={null}>
        <p>body</p>
      </PageTocColumns>,
    );

    expect(document.querySelector('[data-reading-width-scope]')).toBeNull();
    // The structural markers are still there for the shared column.
    expect(document.querySelector('[data-reading-spacer]')).not.toBeNull();
    expect(document.querySelector('[data-reading-right-rail]')).not.toBeNull();
    expect(document.querySelector('[data-reading-content]')).not.toBeNull();
  });

  it.each([false, true])('marks an opted-in shell and keeps the children in place (wide=%s)', (wide) => {
    render(
      <PageTocColumns toc={TOC} activeTocId={null} railActions={<button type="button">copy</button>} wide={wide} readingWidthEnabled>
        <p>body</p>
      </PageTocColumns>,
    );

    const scope = document.querySelector('[data-reading-width-scope="page"]');
    expect(scope).toBe(shell());
    expect(scope?.getAttribute('data-toc-columns')).toBe(wide ? 'wide' : '');
    const content = scope?.querySelector('[data-reading-content]');
    expect(content).toBe(contentColumn());
    expect(content?.className).toContain(wide ? 'min-[1280px]:max-w-[var(--shell-pair)]' : 'max-w-[var(--shell-content)]');
    expect(scope?.querySelector('[data-reading-spacer]')).not.toBeNull();
    expect(!!scope?.querySelector('[data-reading-right-rail]')).toBe(!wide);
    expect(scope?.children).toHaveLength(wide ? 2 : 3);
  });
});
