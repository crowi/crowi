import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageContent } from './page-content';

// The inline modal's `useAttachment` fetch should never need to fire in
// these render-interception tests, but mock the client defensively.
vi.mock('@/lib/api-client', () => ({
  apiClient: { attachment: { getAttachmentMeta: vi.fn() } },
}));

const HEX = 'b'.repeat(24);

/** Build a mdast root whose single paragraph holds one link node. */
function pageWithLink(href: string, text: string): PageWithRevision {
  const renderedAst = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'link', url: href, children: [{ type: 'text', value: text }] }],
      },
    ],
  };
  return {
    revision: { _id: 'rev-1', body: `[${text}](${href})`, renderedAst },
  } as unknown as PageWithRevision;
}

/** Build a mdast root whose single paragraph holds one image node. */
function pageWithImage(src: string, alt: string): PageWithRevision {
  const renderedAst = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'image', url: src, alt }],
      },
    ],
  };
  return {
    revision: { _id: 'rev-2', body: `![${alt}](${src})`, renderedAst },
  } as unknown as PageWithRevision;
}

function renderPage(page: PageWithRevision) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return render(<PageContent page={page} />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PageContent — attachment render interception', () => {
  it('renders an attachment link so a plain left-click is intercepted (no full-page navigation)', () => {
    renderPage(pageWithLink(`/api/v2/attachments/${HEX}`, 'spec'));
    const link = screen.getByRole('link', { name: 'spec' });
    expect(link.getAttribute('href')).toBe(`/api/v2/attachments/${HEX}`);
    // The interception attaches an onClick that calls preventDefault for a
    // plain left-click — observable via the cancelled event.
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
  });

  it('intercepts a legacy /files/<id> attachment link too', () => {
    renderPage(pageWithLink(`/files/${HEX}`, 'legacy'));
    const link = screen.getByRole('link', { name: 'legacy' });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
  });

  it('leaves a normal internal page link as a plain (non-intercepted) link', () => {
    renderPage(pageWithLink('/docs/getting-started', 'docs'));
    const link = screen.getByRole('link', { name: 'docs' });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(clickEvent);
    // A normal link routes through Next.js / browser navigation — the
    // attachment interception does not run, so the event is not cancelled.
    expect(clickEvent.defaultPrevented).toBe(false);
  });

  it('intercepts an embedded attachment image while still rendering the <img>', () => {
    renderPage(pageWithImage(`/api/v2/attachments/${HEX}`, 'a chart'));
    const img = screen.getByRole('img', { name: 'a chart' });
    expect(img.getAttribute('src')).toBe(`/api/v2/attachments/${HEX}`);
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    img.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
  });

  it('leaves a normal embedded image untouched (no click interception)', () => {
    renderPage(pageWithImage('https://example.com/pic.png', 'external pic'));
    const img = screen.getByRole('img', { name: 'external pic' });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    img.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
  });
});
