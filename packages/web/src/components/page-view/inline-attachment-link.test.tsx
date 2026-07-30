import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import type { AttachmentMeta } from '@crowi/api-contract';
import { extractAttachmentId, InlineAttachmentLink, InlineAttachmentProvider } from './inline-attachment-link';

// Mock `apiClient` so the modal's `useAttachment` fetch hits our
// fake. The hook calls `apiClient.attachments[':id'].meta.$get(...)`
// and expects a Response-shaped object (`ok` / `status` / `json`).
const { metaGet } = vi.hoisted(() => ({ metaGet: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    attachments: {
      ':id': {
        meta: { $get: metaGet },
      },
    },
  },
}));

/** Build a `Response`-shaped object matching what `hc` returns. */
const makeResponse = <T,>(status: number, body: T) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const HEX = 'a'.repeat(24);

function makeMeta(): AttachmentMeta {
  return {
    _id: HEX,
    page: 'page-1',
    creator: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    filePath: `attachment/page-1/${HEX}.png`,
    fileName: `${HEX}.png`,
    originalName: 'diagram.png',
    fileFormat: 'image/png',
    fileSize: 2048,
    createdAt: '2026-05-01T09:30:00.000Z',
    url: `/api/attachments/${HEX}`,
    originalUrl: `/api/attachments/${HEX}/original`,
  };
}

function withQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return render(<>{ui}</>, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('extractAttachmentId', () => {
  it('extracts the id from a /api/attachments/<id> URL', () => {
    expect(extractAttachmentId(`/api/attachments/${HEX}`)).toBe(HEX);
  });

  it('extracts the id from a legacy /files/<id> URL', () => {
    expect(extractAttachmentId(`/files/${HEX}`)).toBe(HEX);
  });

  it('tolerates a trailing query string or hash', () => {
    expect(extractAttachmentId(`/api/attachments/${HEX}?dl=1`)).toBe(HEX);
    expect(extractAttachmentId(`/api/attachments/${HEX}#frag`)).toBe(HEX);
  });

  it('lower-cases the extracted id', () => {
    expect(extractAttachmentId(`/api/attachments/${'A'.repeat(24)}`)).toBe(HEX);
  });

  it('returns null for a normal internal page link', () => {
    expect(extractAttachmentId('/docs/getting-started')).toBeNull();
  });

  it('returns null for an external URL', () => {
    expect(extractAttachmentId('https://example.com/page')).toBeNull();
  });

  it('returns null when there is an extra path segment after the id', () => {
    expect(extractAttachmentId(`/api/attachments/${HEX}/extra`)).toBeNull();
  });

  it('returns null for a malformed (non-24-hex) id', () => {
    expect(extractAttachmentId('/api/attachments/not-hex')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(extractAttachmentId(undefined)).toBeNull();
  });
});

describe('InlineAttachmentLink — link variant', () => {
  it('renders an <a> keeping the link text and the raw-file href', () => {
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="link" href={`/api/attachments/${HEX}`}>
          my file
        </InlineAttachmentLink>
      </InlineAttachmentProvider>,
    );
    const link = screen.getByRole('link', { name: 'my file' });
    expect(link.getAttribute('href')).toBe(`/api/attachments/${HEX}`);
  });

  it('opens the detail modal on a plain left-click instead of navigating', async () => {
    metaGet.mockResolvedValue(makeResponse(200, makeMeta()));
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="link" href={`/api/attachments/${HEX}`}>
          my file
        </InlineAttachmentLink>
      </InlineAttachmentProvider>,
    );

    const link = screen.getByRole('link', { name: 'my file' });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    fireEvent(link, clickEvent);
    // Left-click is intercepted — default navigation is prevented.
    expect(clickEvent.defaultPrevented).toBe(true);

    // The shared modal opens once the metadata resolves.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText('diagram.png')).toBeTruthy();
  });

  it('does not intercept a modifier (meta-key) click — native open-in-new-tab still works', () => {
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="link" href={`/api/attachments/${HEX}`}>
          my file
        </InlineAttachmentLink>
      </InlineAttachmentProvider>,
    );
    const link = screen.getByRole('link', { name: 'my file' });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    fireEvent(link, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
  });
});

describe('InlineAttachmentLink — image variant', () => {
  it('renders an <img> keeping the src and alt', () => {
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="image" href={`/api/attachments/${HEX}`} alt="a diagram" />
      </InlineAttachmentProvider>,
    );
    const img = screen.getByRole('img', { name: 'a diagram' });
    expect(img.getAttribute('src')).toBe(`/api/attachments/${HEX}`);
  });

  it('opens the modal on a plain left-click', async () => {
    metaGet.mockResolvedValue(makeResponse(200, makeMeta()));
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="image" href={`/api/attachments/${HEX}`} alt="a diagram" />
      </InlineAttachmentProvider>,
    );
    fireEvent.click(screen.getByRole('img', { name: 'a diagram' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('does not intercept a right-click (button !== 0) — save-image stays available', () => {
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="image" href={`/api/attachments/${HEX}`} alt="a diagram" />
      </InlineAttachmentProvider>,
    );
    const img = screen.getByRole('img', { name: 'a diagram' });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 2 });
    fireEvent(img, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
  });

  it('merges a caller-supplied display style (width/height) with cursor: zoom-in, never replacing it (RFC-0015 §D11 merge contract)', () => {
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="image" href={`/api/attachments/${HEX}`} alt="a diagram" style={{ width: '60%' }} />
      </InlineAttachmentProvider>,
    );
    const img = screen.getByRole('img', { name: 'a diagram' }) as HTMLImageElement;
    expect(img.style.cursor).toBe('zoom-in');
    expect(img.style.width).toBe('60%');
  });

  it('keeps cursor: zoom-in as the sole style when no display style is supplied', () => {
    withQuery(
      <InlineAttachmentProvider>
        <InlineAttachmentLink attachmentId={HEX} variant="image" href={`/api/attachments/${HEX}`} alt="a diagram" />
      </InlineAttachmentProvider>,
    );
    const img = screen.getByRole('img', { name: 'a diagram' }) as HTMLImageElement;
    expect(img.style.cursor).toBe('zoom-in');
    expect(img.style.width).toBe('');
  });
});
