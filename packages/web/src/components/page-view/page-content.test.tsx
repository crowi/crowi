import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { renderMdastToReactNode } from '@/components/editor/render-mdast';
import { previewComponents } from '@/components/editor/markdown-preview';
import { PageContent } from './page-content';

const expandTableLabel = m['page.table_fullscreen_open']();

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

/** Build a page whose revision's `renderedAst` is exactly `renderedAst`. `body` is a non-empty placeholder — `PageContent` renders from `renderedAst` but gates the empty-body message on `body` itself. `id` defaults to a fixed value; pass a distinct one to simulate a new revision landing (see the revision-identity-reset tests below). */
function pageWithAst(renderedAst: unknown, id = 'rev-3'): PageWithRevision {
  return {
    revision: { _id: id, body: 'placeholder', renderedAst },
  } as unknown as PageWithRevision;
}

describe('PageContent — RFC-0015 image display attributes (AC-B1, AC-B3, AC-X1)', () => {
  it('is byte-identical for a plain image with no attribute block — no style, no wrapping figure (AC-X1)', () => {
    renderPage(pageWithImage('https://example.com/pic.png', 'plain pic'));
    const img = screen.getByRole('img', { name: 'plain pic' });
    expect(img.getAttribute('style')).toBeNull();
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('leaves a diagram PNG-fallback embed path unaffected — no display-attribute processing runs before the isDiagramEmbed early return (AC-X3)', () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'image',
              url: '/diagram/render/x.png',
              alt: 'diagram',
              data: { hProperties: { className: 'diagram-embed fake-diagram-embed', 'data-crowi-image-width': '60%' } },
            },
          ],
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));
    const img = screen.getByRole('img', { name: 'diagram' }) as HTMLImageElement;
    // The diagram-embed branch returns its own hard-coded `<img>` before any
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

  it('wraps the page-view table in the fullscreen affordance (outer relative/group-table wrapper + toolbar expand button), outside the overflow-x-auto scrollport', () => {
    renderPage(pageWithAst(gfmTableAst(LONG_TOKEN)));

    const table = screen.getByRole('table');
    // The immediate wrapper is unchanged: still the overflow-x-auto
    // scrollport directly around <table>.
    const scrollWrapper = table.parentElement as HTMLElement;
    expect(scrollWrapper.className).toBe('overflow-x-auto');

    // A NEW outer wrapper carries the fullscreen chrome — relative +
    // named group for the hover-reveal button, and the always-mounted
    // toolbar row containing the expand trigger.
    const outerWrapper = scrollWrapper.parentElement as HTMLElement;
    expect(outerWrapper.className).toContain('relative');
    expect(outerWrapper.className).toContain('group/table');

    const expandButton = screen.getByRole('button', { name: expandTableLabel });
    expect(outerWrapper.contains(expandButton)).toBe(true);
    // The trigger lives OUTSIDE the scrollable wrapper (its own toolbar
    // row), never overlapping cell content.
    expect(scrollWrapper.contains(expandButton)).toBe(false);
  });

  it('renders the identical cell structure/content for the same GFM table on the editor-preview path (parity with page view) — the fullscreen chrome itself is page-view-only', () => {
    const ast = gfmTableAst(LONG_TOKEN);

    renderPage(pageWithAst(ast));
    const pageResult = {
      headerTagNames: screen.getAllByRole('columnheader').map((el) => el.tagName),
      cellTagNames: screen.getAllByRole('cell').map((el) => el.tagName),
      cellText: screen.getAllByRole('cell').map((el) => el.textContent),
    };
    // The immediate scroll wrapper keeps its historical `overflow-x-auto`
    // class list unchanged; the fullscreen chrome is layered OUTSIDE it in
    // a new wrapper rather than modifying it (see
    // `markdown-table-fullscreen.tsx`).
    const pageTable = screen.getByRole('table');
    expect((pageTable.parentElement as HTMLElement).className).toBe('overflow-x-auto');
    cleanup();

    renderPreviewInCrowiProse(ast);
    const previewTable = screen.getByRole('table');
    const previewWrapper = previewTable.parentElement as HTMLElement;

    // Cell-level rendering (tags + text) stays byte-identical across the
    // two surfaces — this feature does not touch thead/tbody/th/td.
    expect(screen.getAllByRole('columnheader').map((el) => el.tagName)).toEqual(pageResult.headerTagNames);
    expect(screen.getAllByRole('cell').map((el) => el.tagName)).toEqual(pageResult.cellTagNames);
    expect(screen.getAllByRole('cell').map((el) => el.textContent)).toEqual(pageResult.cellText);
    // The editor preview keeps its untouched original wrapper (still
    // "my-6 overflow-x-auto" directly around <table>) and has NO fullscreen
    // affordance — `MarkdownPreview.tsx`'s `table` override is zero-diff.
    expect(previewWrapper.className).toBe('my-6 overflow-x-auto');
    expect(previewWrapper.closest('.crowi-prose')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
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

    // Fullscreen affordance is transparent to GFM vs. raw HTML — a raw
    // table with a colliding `class` attribute gets the same expand
    // button + Dialog behaviour.
    const expandButton = screen.getByRole('button', { name: expandTableLabel });
    fireEvent.click(expandButton);

    // Single mount: the table moved into the Radix Dialog portal
    // (document.body), never duplicated — `getByRole('table')` still
    // resolves to exactly one element.
    const dialogTable = screen.getByRole('table');
    expect(document.body.contains(dialogTable)).toBe(true);
    expect(dialogTable.closest('[role="dialog"]')).not.toBeNull();
    expect(screen.getByRole('cell').textContent).toBe(LONG_TOKEN);
  });
});

describe('PageContent — editor preview has no fullscreen affordance (page-view-only scope, negative test)', () => {
  it('renders no expand trigger for a GFM table on the editor-preview path', () => {
    renderPreviewInCrowiProse(gfmTableAst(LONG_TOKEN));
    expect(screen.getByRole('table')).toBeTruthy();
    // Role-independent: a broken implementation that propagates
    // `aria-hidden` instead of not rendering the trigger would still leave
    // a `<button>` node in the DOM even though `queryByRole` excludes it.
    expect(document.body.querySelector('button')).toBeNull();
  });

  it('renders no expand trigger for a raw HTML table on the editor-preview path', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<table class="foo"><tbody><tr><td>x</td></tr></tbody></table>' }],
    };
    renderPreviewInCrowiProse(renderedAst);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(document.body.querySelector('button')).toBeNull();
  });
});

describe('PageContent — own-attribute affordance suppression for an author-hidden / contenteditable raw <table>', () => {
  const cases: Array<[string, string]> = [
    ['hidden', '<table hidden><tbody><tr><td>x</td></tr></tbody></table>'],
    ['hidden="until-found"', '<table hidden="until-found"><tbody><tr><td>x</td></tr></tbody></table>'],
    ['aria-hidden="true"', '<table aria-hidden="true"><tbody><tr><td>x</td></tr></tbody></table>'],
    ['aria-hidden="TRUE"', '<table aria-hidden="TRUE"><tbody><tr><td>x</td></tr></tbody></table>'],
    ['contenteditable', '<table contenteditable><tbody><tr><td>x</td></tr></tbody></table>'],
    ['contenteditable="TRUE"', '<table contenteditable="TRUE"><tbody><tr><td>x</td></tr></tbody></table>'],
    ['contenteditable="PLAINTEXT-ONLY"', '<table contenteditable="PLAINTEXT-ONLY"><tbody><tr><td>x</td></tr></tbody></table>'],
  ];

  it.each(cases)('renders no expand button at all for <table %s> (own-attribute read only, no propagation to the wrapper)', (_label, html) => {
    const { container } = renderPage(pageWithAst({ type: 'root', children: [{ type: 'html', value: html }] }));
    // `queryByRole('button')` alone would false-pass a broken implementation
    // that propagates `aria-hidden` onto the wrapper instead of skipping
    // the toolbar render (the button would still be in the DOM, just
    // excluded from the accessibility tree) — use a role-independent DOM
    // query instead.
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('PageContent — form/interactive content does NOT suppress the fullscreen affordance (regression guard, documented known limitation)', () => {
  it('still shows the expand trigger for a table with a live <input> in a cell', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<table><tbody><tr><td><input type="text" value="draft"></td></tr></tbody></table>' }],
    };
    renderPage(pageWithAst(renderedAst));
    expect(screen.getByRole('button', { name: expandTableLabel })).toBeTruthy();
  });

  it('still shows the expand trigger for a GFM table wrapped in a raw HTML <a href> anchor, and the trigger click opens the dialog instead of navigating', () => {
    const renderedAst = {
      type: 'root',
      children: [
        { type: 'html', value: '<a href="https://example.com/elsewhere">' },
        gfmTableAst('anchored cell').children[0],
        { type: 'html', value: '</a>' },
      ],
    };
    renderPage(pageWithAst(renderedAst));

    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com/elsewhere');
    const expandButton = screen.getByRole('button', { name: expandTableLabel });
    expect(link.contains(expandButton)).toBe(true);

    // `fireEvent.click` returns the underlying `dispatchEvent` result:
    // `false` means the event was cancelled (`preventDefault()` was
    // called) — `handleOpen`'s `preventDefault`/`stopPropagation` stop the
    // ancestor <a>'s native navigation and any ancestor listener, so the
    // click only opens the dialog (「アンカー内トリガーのクリック競合」).
    const notCancelled = fireEvent.click(expandButton);
    expect(notCancelled).toBe(false);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe('PageContent — expand button click interaction shows the table content inside the Dialog portal', () => {
  it('opens the Dialog on click and renders the same cell content inside document.body', () => {
    renderPage(pageWithAst(gfmTableAst('interaction cell')));
    fireEvent.click(screen.getByRole('button', { name: expandTableLabel }));

    // The Dialog mounts into a portal on document.body — query there
    // (mirrors the pattern in attachment-detail-modal.test.tsx).
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('interaction cell');
  });
});

describe('PageContent — single-mount id safety for raw HTML elements carrying an id', () => {
  it('keeps exactly one element with a given id in the document, both closed and after opening the dialog', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<table><tbody><tr><td id="pricing">42</td></tr></tbody></table>' }],
    };
    renderPage(pageWithAst(renderedAst));
    expect(document.querySelectorAll('#pricing')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: expandTableLabel }));
    expect(document.querySelectorAll('#pricing')).toHaveLength(1);
  });
});

describe('PageContent — inline SVG url(#id) references survive the fullscreen Dialog (no subtree id-stripping)', () => {
  it('keeps the gradient id and the fill="url(#id)" reference intact after opening the dialog', () => {
    const svg =
      '<svg><defs><linearGradient id="g"><stop offset="0%" stop-color="red"></stop></linearGradient></defs>' +
      '<rect fill="url(#g)" width="10" height="10"></rect></svg>';
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: `<table><tbody><tr><td>${svg}</td></tr></tbody></table>` }],
    };
    renderPage(pageWithAst(renderedAst));
    expect(document.querySelector('rect')?.getAttribute('fill')).toBe('url(#g)');
    expect(document.querySelectorAll('[id="g"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: expandTableLabel }));
    expect(document.querySelector('rect')?.getAttribute('fill')).toBe('url(#g)');
    expect(document.querySelectorAll('[id="g"]')).toHaveLength(1);
  });
});

describe('PageContent — multiple tables on one page are independent', () => {
  it('opening one table dialog does not affect another table on the same page', () => {
    const renderedAst = {
      type: 'root',
      children: [
        { type: 'html', value: '<table><tbody><tr><td>Table1Cell</td></tr></tbody></table>' },
        { type: 'html', value: '<table><tbody><tr><td>Table2Cell</td></tr></tbody></table>' },
      ],
    };
    renderPage(pageWithAst(renderedAst));
    const buttons = screen.getAllByRole('button', { name: expandTableLabel });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]);

    // The second table's inline content is untouched...
    expect(screen.getByText('Table2Cell')).toBeTruthy();
    // ...and only the first table's content is inside the open dialog.
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Table1Cell');
    expect(dialog?.textContent).not.toContain('Table2Cell');
  });
});

describe('PageContent — revision change resets table dialog identity (fiber-swap / stale-content guard)', () => {
  it('closes an open table dialog when the page revision changes, via the whole-container key={revisionId}', () => {
    const renderedAst = { type: 'root', children: [{ type: 'html', value: '<table><tbody><tr><td>cell</td></tr></tbody></table>' }] };
    const { rerender } = renderPage(pageWithAst(renderedAst, 'rev-a'));

    fireEvent.click(screen.getByRole('button', { name: expandTableLabel }));
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // A new revision lands (same table content, different `_id`) — the
    // whole-container `key={revisionId}` forces a full remount, discarding
    // any stale `open` state instead of risking a positional-key fiber
    // swap onto a different logical table.
    rerender(<PageContent page={pageWithAst(renderedAst, 'rev-b')} />);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('PageContent — diagram embeds reuse the shared DiagramEmbed wrapper (feature-plugin-renderer-mermaid Phase 3, spec §9)', () => {
  const zoomLabel = m['page.diagram_zoom']();

  it('wraps a diagram success <img> (class="diagram-embed fake-diagram-embed") with the click-to-enlarge affordance', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<img class="diagram-embed fake-diagram-embed" alt="Diagram (flowchart)" src="data:image/svg+xml;base64,PHN2Zy8+">' }],
    };
    renderPage(pageWithAst(renderedAst));

    const img = screen.getByRole('img', { name: 'Diagram (flowchart)' }) as HTMLImageElement;
    // alt is present, non-empty, and exactly the fixed/closed-enum literal
    // a diagram renderer plugin emits (spec §9's adversarial invariant —
    // alt is never derived from the diagram source text — is exercised
    // with adversarial payloads at the plugin layer, e.g.
    // `@crowi/plugin-renderer-mermaid`'s `index.test.ts`; this re-checks
    // the Web layer preserves that literal as-is rather than mangling or
    // blanking it).
    expect(img.alt).toBe('Diagram (flowchart)');

    expect(screen.getByRole('button', { name: zoomLabel })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zoomLabel }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img[alt="Diagram (flowchart)"]')).not.toBeNull();
  });

  it("forwards a diagram success <img>'s explicit width/height attributes (regression: a renderer-declared intrinsic size — e.g. Mermaid's SVG has a percentage width with no absolute height — was silently dropped here, collapsing the image to 0×0 inside the inline-block wrapper even though the server-emitted HTML carried it correctly)", () => {
    const renderedAst = {
      type: 'root',
      children: [
        {
          type: 'html',
          value: '<img class="diagram-embed fake-diagram-embed" alt="Diagram (flowchart)" src="data:image/svg+xml;base64,PHN2Zy8+" width="141" height="245">',
        },
      ],
    };
    renderPage(pageWithAst(renderedAst));

    const img = screen.getByRole('img', { name: 'Diagram (flowchart)' }) as HTMLImageElement;
    expect(img.getAttribute('width')).toBe('141');
    expect(img.getAttribute('height')).toBe('245');
  });

  it('does NOT wrap a diagram error placeholder (class="fake-diagram-embed fake-diagram-error", no diagram-embed marker) — no zoom button, no dialog', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<div class="fake-diagram-embed fake-diagram-error" role="status"><span>Diagram could not be rendered</span></div>' }],
    };
    renderPage(pageWithAst(renderedAst));

    expect(screen.getByRole('status').textContent).toContain('Diagram could not be rendered');
    expect(screen.queryByRole('button', { name: zoomLabel })).toBeNull();
  });

  it('wraps a different diagram producer\'s SVG success <div> (class="diagram-embed other-fake-diagram-embed") with the same wrapper', () => {
    const renderedAst = {
      type: 'root',
      children: [{ type: 'html', value: '<div class="diagram-embed other-fake-diagram-embed"><svg><rect width="10" height="10"/></svg></div>' }],
    };
    renderPage(pageWithAst(renderedAst));

    expect(screen.getByRole('button', { name: zoomLabel })).toBeTruthy();
    expect(document.querySelector('svg rect')).not.toBeNull();
  });
});
