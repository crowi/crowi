import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import type { PageWithRevision } from '@crowi/api-contract';
import { renderMdastToReactNode } from '@/components/editor/render-mdast';
import { previewComponents } from '@/components/editor/MarkdownPreview';
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

/** Build a page whose revision's `renderedAst` is exactly `renderedAst`. `body` is a non-empty placeholder — `PageContent` renders from `renderedAst` but gates the empty-body message on `body` itself. */
function pageWithAst(renderedAst: unknown): PageWithRevision {
  return {
    revision: { _id: 'rev-3', body: 'placeholder', renderedAst },
  } as unknown as PageWithRevision;
}

describe('PageContent — RFC-0015 image display attributes (AC-B1, AC-B3, AC-X1)', () => {
  it('is byte-identical for a plain image with no attribute block — no style, no wrapping figure (AC-X1)', () => {
    renderPage(pageWithImage('https://example.com/pic.png', 'plain pic'));
    const img = screen.getByRole('img', { name: 'plain pic' });
    expect(img.getAttribute('style')).toBeNull();
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('leaves the PlantUML PNG-fallback embed path unaffected — no display-attribute processing runs before the plantuml-embed early return (AC-X3)', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'image',
              url: '/plantuml/render/x.png',
              alt: 'diagram',
              data: { hProperties: { className: 'plantuml-embed', 'data-crowi-image-width': '60%' } },
            },
          ],
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));
    const img = screen.getByRole('img', { name: 'diagram' }) as HTMLImageElement;
    // The plantuml branch returns its own hard-coded `<img>` before any
    // display-attribute code runs — no style, class is the plain
    // responsive utility set, not a display-attribute-derived one.
    expect(img.getAttribute('style')).toBeNull();
    expect(img.className).toBe('max-w-full h-auto');
  });

  it('applies a validated width as inline style on a plain (non-attachment, non-standalone) image and never leaks the transport attribute', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'image', url: 'https://example.com/pic.png', alt: 'sized pic', data: { hProperties: { 'data-crowi-image-width': '60%' } } },
            { type: 'text', value: ' trailing text' },
          ],
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));
    const img = screen.getByRole('img', { name: 'sized pic' }) as HTMLImageElement;
    expect(img.style.width).toBe('60%');
    expect(img.getAttribute('data-crowi-image-width')).toBeNull();
  });

  it('merges an unrelated raw <img> class/style with the base classes/display style instead of replacing them (AC-B3)', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'html',
          value: '<img src="/x.png" alt="raw img" class="user-class" style="border: 1px solid red" data-crowi-image-width="60%">',
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));
    const img = screen.getByRole('img', { name: 'raw img' }) as HTMLImageElement;
    // Base renderer classes + the raw `class` survive together, not one replacing the other.
    expect(img.className.split(' ')).toEqual(expect.arrayContaining(['max-w-full', 'h-auto', 'rounded-lg', 'my-6', 'user-class']));
    // The raw inline style and the re-validated display style both apply.
    expect(img.style.border).toBe('1px solid red');
    expect(img.style.width).toBe('60%');
    expect(img.getAttribute('data-crowi-image-width')).toBeNull();
  });

  it('applies the same class/style merge on the preview path (parity with the page-view fix above, AC-B3/AC-B6)', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'html',
          value: '<img src="/x.png" alt="raw img" class="user-class" style="border: 1px solid red" data-crowi-image-width="60%">',
        },
      ],
    };
    const previewNode = renderMdastToReactNode(renderedAst, {
      sectionWrap: false,
      components: previewComponents as unknown as Parameters<typeof renderMdastToReactNode>[1]['components'],
    });
    render(<>{previewNode}</>);
    const img = screen.getByRole('img', { name: 'raw img' }) as HTMLImageElement;
    expect(img.className.split(' ')).toEqual(expect.arrayContaining(['max-w-full', 'h-auto', 'rounded-lg', 'my-6', 'user-class']));
    expect(img.style.border).toBe('1px solid red');
    expect(img.style.width).toBe('60%');
  });
});

describe('PageContent — standalone attachment figure: layer split, no double-application (AC-B5)', () => {
  it('puts align/float on the figure and width on the inner attachment img, preserving cursor + click interception', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          data: { hName: 'figure', hProperties: { className: 'crowi-figure', 'data-crowi-image-float': 'right' } },
          children: [
            {
              type: 'image',
              url: `/api/v2/attachments/${HEX}`,
              alt: 'a chart',
              data: { hProperties: { 'data-crowi-image-width': '40%' } },
            },
          ],
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));

    const figure = screen.getByRole('figure');
    expect(figure.className).toBe('crowi-figure crowi-image-float-right');
    expect(figure.getAttribute('style')).toBeNull();
    expect(figure.getAttribute('data-crowi-image-width')).toBeNull();

    const img = screen.getByRole('img', { name: 'a chart' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/v2/attachments/${HEX}`);
    expect(img.style.width).toBe('40%');
    // Width never leaks onto the figure, float never leaks onto the img —
    // each display prop is applied by exactly one layer.
    expect(img.style.getPropertyValue('float')).toBe('');

    // `cursor: zoom-in` + modal click-interception survive the merge
    // (§D11 merge contract) — the attachment routing still applies to
    // the inner img even though it's wrapped in a synthesized figure.
    expect(img.style.cursor).toBe('zoom-in');
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    img.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
  });
});

describe('PageContent — page-view / preview parity for the same data-crowi-image-* input (AC-B6)', () => {
  it('renders the same figure className + img style as the preview path (excluding page-view-only cursor/modal)', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          data: { hName: 'figure', hProperties: { className: 'crowi-figure', 'data-crowi-image-align': 'center' } },
          children: [{ type: 'image', url: 'https://example.com/pic.png', alt: 'parity pic', data: { hProperties: { 'data-crowi-image-height': '240px' } } }],
        },
      ],
    };

    renderPage(pageWithAst(renderedAst));
    const pageFigure = screen.getByRole('figure');
    const pageImg = screen.getByRole('img', { name: 'parity pic' }) as HTMLImageElement;
    const pageResult = { figureClassName: pageFigure.className, imgWidth: pageImg.style.width, imgHeight: pageImg.style.height };
    cleanup();

    const previewNode = renderMdastToReactNode(renderedAst, {
      sectionWrap: false,
      components: previewComponents as unknown as Parameters<typeof renderMdastToReactNode>[1]['components'],
    });
    render(<>{previewNode}</>);
    const previewFigure = screen.getByRole('figure');
    const previewImg = screen.getByRole('img', { name: 'parity pic' }) as HTMLImageElement;

    expect(previewFigure.className).toBe(pageResult.figureClassName);
    expect(previewImg.style.width).toBe(pageResult.imgWidth);
    expect(previewImg.style.height).toBe(pageResult.imgHeight);
    // Preview never routes through InlineAttachmentLink — no cursor style.
    expect(previewImg.style.cursor).toBe('');
  });
});

describe('PageContent — forged-marker-safe figure gating (AC-B4)', () => {
  it('applies only the fixed, re-validated layout class to a raw-HTML-forged marker figure, dropping the raw style/extra class/injection payload', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'html',
          value:
            '<figure class="crowi-figure evil-class" style="position:fixed;top:0;left:0" data-crowi-image-align="center;--x:url(evil)"><img src="/evil.png" alt="forged"></figure>',
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));

    const figure = screen.getByRole('figure');
    // Only the marker + (no valid align, since the value is malformed)
    // — no `evil-class`, no forged inline style.
    expect(figure.className).toBe('crowi-figure');
    expect(figure.getAttribute('style')).toBeNull();
    expect(screen.getByRole('img', { name: 'forged' })).toBeTruthy();
  });

  it('applies the fixed layout class for a well-formed forged align value (no more powerful than an author-written one)', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<figure class="crowi-figure" data-crowi-image-align="center"><img src="/x.png" alt="pic"></figure>' }],
    };
    renderPage(pageWithAst(renderedAst));
    const figure = screen.getByRole('figure');
    expect(figure.className).toBe('crowi-figure crowi-image-align-center');
  });

  it('passes a marker-less raw <figure> through untouched', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<figure class="user-class"><img src="/x.png" alt="pic"><figcaption>Caption</figcaption></figure>' }],
    };
    renderPage(pageWithAst(renderedAst));
    const figure = screen.getByRole('figure');
    expect(figure.className).toBe('user-class');
    expect(screen.getByText('Caption')).toBeTruthy();
  });

  it('preserves an inline style on a marker-less raw <figure> (ordinary passthrough — style is only ever dropped on a marker-bearing figure)', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<figure class="user-class" style="border: 1px solid red"><img src="/x.png" alt="pic"></figure>' }],
    };
    renderPage(pageWithAst(renderedAst));
    const figure = screen.getByRole('figure');
    expect(figure.getAttribute('style')).toBe('border: 1px solid red;');
  });
});

describe('PageContent — height override + max-width invariant (AC-B7)', () => {
  it('sets a valid height as inline style (which wins over the h-auto utility class in the CSS cascade) while keeping max-w-full for responsiveness', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'image', url: 'https://example.com/pic.png', alt: 'tall pic', data: { hProperties: { 'data-crowi-image-height': '240px' } } },
            { type: 'text', value: ' trailing text' },
          ],
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));
    const img = screen.getByRole('img', { name: 'tall pic' }) as HTMLImageElement;
    expect(img.style.height).toBe('240px');
    expect(img.className).toContain('max-w-full');
  });

  it('keeps no inline height (h-auto governs) when no valid height attribute is present', () => {
    renderPage(pageWithImage('https://example.com/pic.png', 'auto height pic'));
    const img = screen.getByRole('img', { name: 'auto height pic' }) as HTMLImageElement;
    expect(img.style.height).toBe('');
    expect(img.className).toContain('h-auto');
    expect(img.className).toContain('max-w-full');
  });
});

const LONG_TOKEN = 'apps/api/src/schema/migrations/2026-07-08-add-auth-token-family-columns.sql';

/** A minimal GFM table mdast: a header row (becomes `<thead><tr><th>`) plus one body row (`<tbody><tr><td>`), matching how `mdast-util-to-hast`'s `table` handler shapes GFM `|...|` tables (see `mdast-util-to-hast/lib/handlers/table.js`). `cellValue` seeds the first body cell so a long-token regression is easy to assert on. */
function gfmTableAst(cellValue: string) {
  return {
    type: 'root',
    children: [
      {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [{ type: 'text', value: 'Path' }] },
              { type: 'tableCell', children: [{ type: 'text', value: 'Note' }] },
            ],
          },
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [{ type: 'text', value: cellValue }] },
              { type: 'tableCell', children: [{ type: 'text', value: 'migration file' }] },
            ],
          },
        ],
      },
    ],
  };
}

/** Render `renderedAst` through the preview path the same way `MarkdownPreview` wraps its output in production — inside a `.crowi-prose` container (see `MarkdownPreview.tsx`'s default `className ?? 'crowi-prose min-w-0'`) — so `.crowi-prose th`/`.crowi-prose td` scoping is exercised the same way it is at runtime, not left unscoped like the bare `renderMdastToReactNode` calls above (which don't need `.crowi-prose` for their own assertions). */
function renderPreviewInCrowiProse(renderedAst: unknown) {
  const previewNode = renderMdastToReactNode(renderedAst, {
    sectionWrap: false,
    components: previewComponents as unknown as Parameters<typeof renderMdastToReactNode>[1]['components'],
  });
  return render(<div className="crowi-prose min-w-0">{previewNode}</div>);
}

describe('PageContent — GFM table DOM parity: page view vs. editor preview (mobile table-scroll fix)', () => {
  it('renders the overflow-x-auto wrapper > table > th/td structure, inside .crowi-prose, on the page-view path', () => {
    renderPage(pageWithAst(gfmTableAst(LONG_TOKEN)));

    const table = screen.getByRole('table');
    const wrapper = table.parentElement as HTMLElement;
    expect(wrapper.className).toContain('overflow-x-auto');
    expect(wrapper.closest('.crowi-prose')).not.toBeNull();

    const headerCells = screen.getAllByRole('columnheader');
    expect(headerCells).toHaveLength(2);
    expect(headerCells.every((el) => el.tagName === 'TH')).toBe(true);

    const dataCells = screen.getAllByRole('cell');
    expect(dataCells).toHaveLength(2);
    expect(dataCells.every((el) => el.tagName === 'TD')).toBe(true);
    expect(dataCells[0].textContent).toBe(LONG_TOKEN);
  });

  it('renders the identical wrapper/table/th/td structure for the same GFM table on the editor-preview path (parity with page view)', () => {
    const ast = gfmTableAst(LONG_TOKEN);

    renderPage(pageWithAst(ast));
    const pageTable = screen.getByRole('table');
    const pageWrapper = pageTable.parentElement as HTMLElement;
    const pageResult = {
      wrapperClassName: pageWrapper.className,
      tableClassName: pageTable.className,
      headerTagNames: screen.getAllByRole('columnheader').map((el) => el.tagName),
      cellTagNames: screen.getAllByRole('cell').map((el) => el.tagName),
      cellText: screen.getAllByRole('cell').map((el) => el.textContent),
    };
    cleanup();

    renderPreviewInCrowiProse(ast);
    const previewTable = screen.getByRole('table');
    const previewWrapper = previewTable.parentElement as HTMLElement;

    expect(previewWrapper.className).toBe(pageResult.wrapperClassName);
    expect(previewTable.className).toBe(pageResult.tableClassName);
    expect(screen.getAllByRole('columnheader').map((el) => el.tagName)).toEqual(pageResult.headerTagNames);
    expect(screen.getAllByRole('cell').map((el) => el.tagName)).toEqual(pageResult.cellTagNames);
    expect(screen.getAllByRole('cell').map((el) => el.textContent)).toEqual(pageResult.cellText);
    expect(previewWrapper.closest('.crowi-prose')).not.toBeNull();
  });
});

describe('PageContent — raw HTML <table> keeps its tag structure + .crowi-prose scope under conflicting class attributes', () => {
  it('preserves table/th/td tags and .crowi-prose scope for a raw HTML table carrying conflicting whitespace/wrap utility classes', () => {
    // `known-tags.ts` allow-lists table/thead/tbody/tr/th/td, so this raw
    // HTML block survives `escapeUnknownRawHtml` + `raw()` as real elements
    // instead of being demoted to text or stripped (see `render-mdast.ts`).
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'html',
          value:
            `<table class="foo"><thead><tr><th class="whitespace-normal">Path</th></tr></thead>` +
            `<tbody><tr><td class="whitespace-normal break-all">${LONG_TOKEN}</td></tr></tbody></table>`,
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));

    const table = screen.getByRole('table');
    expect(table.tagName).toBe('TABLE');
    expect(table.closest('.crowi-prose')).not.toBeNull();

    const th = screen.getByRole('columnheader');
    expect(th.tagName).toBe('TH');
    // The raw `class` still lands on the DOM node (JSX spreads `...props`,
    // including the raw `class`, after the component's base `className`) —
    // deciding which wins at the *computed-style* level is the unlayered
    // `.crowi-prose th, .crowi-prose td` CSS rule in `globals.css`, which
    // jsdom does not load (see `vitest.config.ts`) and is therefore out of
    // scope for this assertion; only the tag/structure survival is checked
    // here.
    expect(th.className).toContain('whitespace-normal');

    const td = screen.getByRole('cell');
    expect(td.tagName).toBe('TD');
    expect(td.className).toContain('whitespace-normal');
    expect(td.className).toContain('break-all');
    expect(td.textContent).toBe(LONG_TOKEN);
  });
});
