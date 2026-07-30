import { m } from '@paraglide/messages.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `usePreview` itself is covered by `use-preview.test.ts`; mocked here so
// this file controls exactly when each call's promise settles.
const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/lib/use-preview', () => ({ usePreview: () => ({ mutateAsync }) }));

import { MarkdownPreview } from './markdown-preview';

const DEBOUNCE_MS = 250;

beforeEach(() => {
  vi.useFakeTimers();
  mutateAsync.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * feature-plugin-renderer-mermaid spec §7 item 8/12 — proves
 * `MarkdownPreview.tsx` needs NO change for the `use-preview.ts`
 * AbortController wiring: its existing `stale` cleanup flag already
 * ignores a superseded request's rejection (an aborted fetch rejects the
 * SAME way a network failure would) instead of surfacing the "Preview
 * failed" error state.
 */
describe('MarkdownPreview — stale-guard on a superseded (aborted) preview request', () => {
  it('does not show the error state when a request superseded by a `source` change later rejects with an AbortError', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const firstCall = new Promise<unknown>((_resolve, reject) => {
      rejectFirst = reject;
    });
    mutateAsync.mockReturnValueOnce(firstCall);
    mutateAsync.mockReturnValueOnce(new Promise(() => {})); // second call never settles in this test

    const { rerender } = render(<MarkdownPreview source="first" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenNthCalledWith(1, 'first');

    // `source` changes before the first request settles — React runs the
    // effect cleanup (sets `stale = true` on the FIRST effect's closure)
    // synchronously as part of this re-render, exactly as
    // `use-preview.ts`'s own AbortController fires around the same time.
    rerender(<MarkdownPreview source="second" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync).toHaveBeenNthCalledWith(2, 'second');

    // The superseded (first) request now rejects — as an aborted preview
    // fetch would (`use-preview.ts`'s AbortController.abort()).
    await act(async () => {
      rejectFirst?.(new DOMException('The operation was aborted.', 'AbortError'));
      await firstCall.catch(() => undefined);
    });

    // No "Preview failed" text — the stale flag's early-return in
    // `.catch()` swallowed it before `setErrored(true)` could run.
    expect(screen.queryByText(m['edit.preview_failed']())).not.toBeInTheDocument();
  });
});

/**
 * feature-plugin-renderer-mermaid Phase 3 (spec §9) — the editor preview
 * pane reuses the exact same `isDiagramEmbed`/`DiagramEmbed` wrapper as
 * the show page (`page-content.test.tsx` covers the page-view side of
 * this same invariant), so a `previewPolicy:'server-render'` diagram
 * code-fence gets click-to-enlarge parity while still being edited.
 */
describe('MarkdownPreview — diagram embed gets the same DiagramEmbed wrapper as the show page', () => {
  it('wraps a diagram success <img> (class="diagram-embed fake-diagram-embed") with the click-to-enlarge affordance', async () => {
    const ast = {
      type: 'root',
      children: [
        {
          type: 'html',
          value:
            '<div data-source-line="1"><img class="diagram-embed fake-diagram-embed" alt="Diagram (flowchart)" src="data:image/svg+xml;base64,PHN2Zy8+"></div>',
        },
      ],
    };
    mutateAsync.mockResolvedValueOnce(ast);

    render(<MarkdownPreview source="```diagram\nflowchart TD\n  A --> B\n```" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(screen.getByRole('img', { name: 'Diagram (flowchart)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: m['page.diagram_zoom']() })).toBeTruthy();
  });

  it('does NOT wrap a diagram error placeholder (no diagram-embed marker) — renders the status text with no zoom button', async () => {
    const ast = {
      type: 'root',
      children: [{ type: 'html', value: '<div class="fake-diagram-embed fake-diagram-error" role="status"><span>Diagram could not be rendered</span></div>' }],
    };
    mutateAsync.mockResolvedValueOnce(ast);

    render(<MarkdownPreview source="```diagram\nnot a real diagram\n```" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(screen.getByRole('status').textContent).toContain('Diagram could not be rendered');
    expect(screen.queryByRole('button', { name: m['page.diagram_zoom']() })).toBeNull();
  });

  it("forwards a diagram success <img>'s explicit width/height attributes (regression: dropped here even after page-content.tsx's parallel fix, causing a preview/page-render 0×0 divergence)", async () => {
    const ast = {
      type: 'root',
      children: [
        {
          type: 'html',
          value:
            '<div data-source-line="1"><img class="diagram-embed fake-diagram-embed" alt="Diagram (flowchart)" src="data:image/svg+xml;base64,PHN2Zy8+" width="141" height="245"></div>',
        },
      ],
    };
    mutateAsync.mockResolvedValueOnce(ast);

    render(<MarkdownPreview source="```diagram\nflowchart TD\n  A --> B\n```" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    const img = screen.getByRole('img', { name: 'Diagram (flowchart)' }) as HTMLImageElement;
    expect(img.getAttribute('width')).toBe('141');
    expect(img.getAttribute('height')).toBe('245');
  });
});

describe('MarkdownPreview — link-card placeholder', () => {
  it('renders a card tag as a non-clickable card without fetching its metadata', async () => {
    const url = 'https://almoha.slack.com/archives/C0154CS303Z/p1784556099049899';
    mutateAsync.mockResolvedValueOnce({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          data: { hProperties: { 'data-source-line': 1 } },
          children: [
            { type: 'text', value: '@' },
            { type: 'link', url, children: [{ type: 'text', value: 'card' }] },
          ],
        },
      ],
    });

    render(<MarkdownPreview source={`@[card](${url})`} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(screen.getByText(url)).toBeTruthy();
    expect(screen.getByText(m['edit.link_card_preview_pending']())).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('.crowi-link-card-preview-surface')).toBeTruthy();
  });

  it("renders a card tag as a non-clickable card even mid-sentence (not just when it is the paragraph's sole content)", async () => {
    // `applyLinkCardConversion` (link-card-affordance-extension.ts) only
    // replaces the bare-URL span it found, so converting a URL that isn't
    // alone on its own line leaves the card tag as one triple among
    // several paragraph children — repro for the case the placeholder
    // matcher used to miss (it required the paragraph's ONLY children to
    // be the triple), which fell through to a real clickable link.
    const url = 'https://example.com/doc';
    mutateAsync.mockResolvedValueOnce({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          data: { hProperties: { 'data-source-line': 1 } },
          children: [
            { type: 'text', value: 'See ' },
            { type: 'text', value: '@' },
            { type: 'link', url, children: [{ type: 'text', value: 'card' }] },
            { type: 'text', value: ' for details.' },
          ],
        },
      ],
    });

    render(<MarkdownPreview source={`See @[card](${url}) for details.`} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    // Checked via the single paragraph's own textContent (not
    // `screen.getByText(/^See\s*$/)` in isolation): a bare-text-node match
    // only works if "See " sits alone in its own element, which is exactly
    // the pre-fix bug repro'd below — a block-level placeholder tag
    // (`<figure>`/`<div>`) implicitly closes an open `<p>` per HTML5's
    // tree-construction rules and does NOT reopen one afterward, so "See "
    // and "for details." would land in two SEPARATE `<p>` elements instead
    // of staying together in the one true source paragraph.
    const paragraphs = document.querySelectorAll('p');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].textContent).toContain('See');
    expect(paragraphs[0].textContent).toMatch(/for details\.$/);
    expect(screen.getByText(url)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('.crowi-link-card-preview-surface')).toBeTruthy();
  });

  it('converts a card tag nested inside emphasis (e.g. `**@[card](url)**`), not just a paragraph-direct triple', async () => {
    // `@[tag](url)` is documented as general Markdown syntax any user can
    // type directly (not only via the affordance's own conversion action,
    // which never nests it), so `**@[card](url)**` is a reachable source a
    // user can hand-type. Left unconverted, the (text, link, text) triple
    // stays a real `link` node and renders as a clickable link in preview.
    const url = 'https://example.com/doc';
    mutateAsync.mockResolvedValueOnce({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          data: { hProperties: { 'data-source-line': 1 } },
          children: [
            {
              type: 'strong',
              children: [
                { type: 'text', value: '@' },
                { type: 'link', url, children: [{ type: 'text', value: 'card' }] },
              ],
            },
          ],
        },
      ],
    });

    render(<MarkdownPreview source={`**@[card](${url})**`} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(screen.getByText(url)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('.crowi-link-card-preview-surface')).toBeTruthy();
  });
});

describe('MarkdownPreview — linkCardEnabled=false gates the placeholder substitution (feature-renderer-plugin-boundary Phase 3 spec §6.3)', () => {
  it('defaults to enabled: an omitted linkCardEnabled prop still converts the card tag to the placeholder', async () => {
    const url = 'https://example.com/doc';
    mutateAsync.mockResolvedValueOnce({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '@' },
            { type: 'link', url, children: [{ type: 'text', value: 'card' }] },
          ],
        },
      ],
    });

    render(<MarkdownPreview source={`@[card](${url})`} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(document.querySelector('.crowi-link-card-preview-surface')).toBeTruthy();
  });

  it('disabled: the card tag is NOT converted to the static placeholder — it renders as an ordinary clickable link, same as any other unrecognised embed tag', async () => {
    const url = 'https://example.com/doc';
    mutateAsync.mockResolvedValueOnce({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '@' },
            { type: 'link', url, children: [{ type: 'text', value: 'card' }] },
          ],
        },
      ],
    });

    render(<MarkdownPreview source={`@[card](${url})`} linkCardEnabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(document.querySelector('.crowi-link-card-preview-surface')).toBeNull();
    expect(screen.queryByText(m['edit.link_card_preview_pending']())).toBeNull();
    // The `@` prefix + a real anchor to the card's url survive unconverted.
    const link = screen.getByRole('link', { name: 'card' });
    expect(link.getAttribute('href')).toBe(url);
  });
});

// feature-api-v2-path-removal Phase 3 §5.3 — the `img:`/`a:` overrides pass
// `src`/`href` through `canonicalizeLegacyAttachmentUrl()` before handing it
// to the DOM. Without this, a page whose body still embeds a legacy
// `/api/v2/attachments/<id>` reference would show a broken image ONLY in
// split preview (page-content.test.tsx's parallel describe block covers the
// show-page side) — this is what AC calls view/preview parity.
describe('MarkdownPreview — legacy attachment URL canonicalization (feature-api-v2-path-removal Phase 3, view/preview parity)', () => {
  const HEX = 'c'.repeat(24);

  it('renders a legacy /api/v2/attachments/<id> image src as the canonical /api/attachments/<id>', async () => {
    mutateAsync.mockResolvedValueOnce({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'image', url: `/api/v2/attachments/${HEX}`, alt: 'legacy pic' }] }],
    });

    render(<MarkdownPreview source={`![legacy pic](/api/v2/attachments/${HEX})`} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    const img = screen.getByRole('img', { name: 'legacy pic' });
    // Same canonical value `page-content.tsx` renders for the identical
    // input (page-content.test.tsx's "legacy attachment URL
    // canonicalization" describe block) — view/preview parity.
    expect(img.getAttribute('src')).toBe(`/api/attachments/${HEX}`);
  });

  it('renders a legacy /api/v2/attachments/<id> link href as the canonical /api/attachments/<id>', async () => {
    mutateAsync.mockResolvedValueOnce({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'link', url: `/api/v2/attachments/${HEX}`, children: [{ type: 'text', value: 'legacy link' }] }] }],
    });

    render(<MarkdownPreview source={`[legacy link](/api/v2/attachments/${HEX})`} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    const link = screen.getByRole('link', { name: 'legacy link' });
    expect(link.getAttribute('href')).toBe(`/api/attachments/${HEX}`);
  });
});
