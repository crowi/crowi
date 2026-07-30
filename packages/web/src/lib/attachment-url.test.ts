import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same trick as resolve-mcp-endpoint.test.ts: `env()` is the runtime reader,
// mocked so a single test can change what `NEXT_PUBLIC_API_URL` resolves to
// between calls (drives `apiOrigin()`, which `canonicalizeLegacyAttachmentUrl`
// consults for the self-host-absolute branch).
const envMock = vi.fn<(key: string) => string | undefined>();
vi.mock('./runtime-env', () => ({ env: (key: string) => envMock(key) }));

import { canonicalizeLegacyAttachmentUrl } from './attachment-url';

const ID = 'a'.repeat(24);

describe('canonicalizeLegacyAttachmentUrl', () => {
  beforeEach(() => {
    envMock.mockReset();
    envMock.mockReturnValue(undefined);
  });

  it('replaces a root-relative legacy URL unconditionally', () => {
    expect(canonicalizeLegacyAttachmentUrl(`/api/v2/attachments/${ID}`)).toBe(`/api/attachments/${ID}`);
  });

  it('preserves a trailing /original suffix on a root-relative legacy URL', () => {
    expect(canonicalizeLegacyAttachmentUrl(`/api/v2/attachments/${ID}/original`)).toBe(`/api/attachments/${ID}/original`);
  });

  it('preserves query and hash on a root-relative legacy URL', () => {
    expect(canonicalizeLegacyAttachmentUrl(`/api/v2/attachments/${ID}?dl=1#frag`)).toBe(`/api/attachments/${ID}?dl=1#frag`);
  });

  it('preserves the encoded key of a by-key legacy URL', () => {
    expect(canonicalizeLegacyAttachmentUrl('/api/v2/attachments/by-key/user%2Fabc.png')).toBe('/api/attachments/by-key/user%2Fabc.png');
  });

  it('replaces a self-host absolute legacy URL (NEXT_PUBLIC_API_URL set) and keeps the origin', () => {
    envMock.mockReturnValue('https://wiki.example.com');
    expect(canonicalizeLegacyAttachmentUrl(`https://wiki.example.com/api/v2/attachments/${ID}`)).toBe(`https://wiki.example.com/api/attachments/${ID}`);
  });

  it('replaces a self-host absolute legacy URL resolved via window.location.origin (no NEXT_PUBLIC_API_URL)', () => {
    expect(canonicalizeLegacyAttachmentUrl(`${window.location.origin}/api/v2/attachments/${ID}`)).toBe(`${window.location.origin}/api/attachments/${ID}`);
  });

  it('does NOT replace an other-host absolute legacy URL (negative test)', () => {
    const url = `https://other-crowi.example/api/v2/attachments/${ID}`;
    expect(canonicalizeLegacyAttachmentUrl(url)).toBe(url);
  });

  it('does NOT replace a protocol-relative legacy URL', () => {
    const url = `//other.example/api/v2/attachments/${ID}`;
    expect(canonicalizeLegacyAttachmentUrl(url)).toBe(url);
  });

  it('does NOT replace a similarly-prefixed but different other-host origin (no false positive on origin prefix match)', () => {
    envMock.mockReturnValue('https://wiki.example.com');
    const url = `https://wiki.example.com.evil.example/api/v2/attachments/${ID}`;
    expect(canonicalizeLegacyAttachmentUrl(url)).toBe(url);
  });

  it('leaves an already-canonical /api/attachments/<id> URL unchanged', () => {
    const url = `/api/attachments/${ID}`;
    expect(canonicalizeLegacyAttachmentUrl(url)).toBe(url);
  });

  it('leaves a v1 /files/<id> URL unchanged (permanent redirect resolves it, out of scope for this helper)', () => {
    const url = `/files/${ID}`;
    expect(canonicalizeLegacyAttachmentUrl(url)).toBe(url);
  });

  it('leaves a normal internal page link unchanged', () => {
    expect(canonicalizeLegacyAttachmentUrl('/docs/getting-started')).toBe('/docs/getting-started');
  });

  it('returns undefined for undefined', () => {
    expect(canonicalizeLegacyAttachmentUrl(undefined)).toBeUndefined();
  });

  it('is idempotent — applying it twice yields the same result as applying it once', () => {
    const once = canonicalizeLegacyAttachmentUrl(`/api/v2/attachments/${ID}/original?dl=1#frag`);
    const twice = canonicalizeLegacyAttachmentUrl(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for an already-canonical self-host absolute URL', () => {
    envMock.mockReturnValue('https://wiki.example.com');
    const url = `https://wiki.example.com/api/attachments/${ID}`;
    expect(canonicalizeLegacyAttachmentUrl(url)).toBe(url);
  });
});
