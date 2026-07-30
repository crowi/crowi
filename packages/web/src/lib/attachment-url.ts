/**
 * Canonicalize a persisted attachment reference that still carries the
 * legacy (pre-`/api/v2` → `/api` cutover) `/api/v2/attachments/...` prefix,
 * for display purposes only.
 *
 * feature-api-v2-path-removal §5.3 — producer output flipped to
 * `/api/attachments/...` (`Attachment.fileUrl` / `BY_KEY_URL_PREFIX`), but
 * `Revision.body` / `User.image` persisted before the cutover still embed
 * the old `/api/v2/attachments/...` form, and no DB-rewriting migration is
 * run to fix that up (see "やらないこと"). This is the single, shared
 * display-time defence: every render call site that puts a persisted URL
 * into `<img src>` / `<a href>` routes it through this function first.
 *
 * Deliberately a **substring replace**, never an ID-extract-and-rebuild:
 * `extractAttachmentId()` (`inline-attachment-link.tsx`) only recognises a
 * 24-hex ObjectId as the final path segment, so re-deriving the URL from
 * just the id would silently drop the original's origin (absolute URLs),
 * query, hash, `/original` suffix, and by-key form's encoded key. A pure
 * substring replace preserves all of that verbatim.
 *
 * Only replaces a URL that is unambiguously THIS Crowi instance's own:
 *   - root-relative (`/api/v2/attachments/...`) — always this site, replaced
 *     unconditionally.
 *   - absolute, but only when its origin matches this app's own resolved
 *     origin (`apiOrigin()` / `window.location.origin`, the same fallback
 *     chain `resolveMcpEndpoint()` uses) — replaced.
 *   - any other absolute URL (a different host) and protocol-relative
 *     (`//host/...`) URLs are left completely unchanged — rewriting those
 *     would corrupt a link that genuinely points at a DIFFERENT (still on
 *     v2) Crowi instance.
 *
 * `/files/<id>` (v1) is intentionally NOT handled here — the permanent
 * `GET /files/:id` → 302 redirect resolves it server-side, so display-time
 * rewriting is unnecessary (and out of scope, spec §5.3).
 *
 * Idempotent: the output never contains the `/api/v2/attachments/` substring
 * again, so re-applying this function is always a no-op.
 */

import { apiOrigin } from './api-client';

/** Legacy (pre-cutover) root-relative attachment URL prefix. */
const LEGACY_ATTACHMENT_PREFIX = '/api/v2/attachments/';

/** Canonical (current) root-relative attachment URL prefix. */
const CANONICAL_ATTACHMENT_PREFIX = '/api/attachments/';

/**
 * This app's own origin, for judging whether an absolute URL is self-host.
 * Same fallback chain as `resolveMcpEndpoint()`: `NEXT_PUBLIC_API_URL` (split
 * host) first, then `window.location.origin` (same-origin default). Empty
 * when neither is available — e.g. server-side rendering without the env var
 * set (`page-display-user-badge.tsx` has no `'use client'` directive and can
 * render there), which disables the self-host-absolute branch below (only
 * root-relative URLs are still rewritten), mirroring how
 * `files-url-to-attachments.ts`'s rule 2 disables when `CLIENT_URL`/
 * `BASE_URL` are unset.
 */
function selfOrigin(): string {
  return apiOrigin() || (typeof window !== 'undefined' ? window.location.origin : '');
}

export function canonicalizeLegacyAttachmentUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;

  if (url.startsWith(LEGACY_ATTACHMENT_PREFIX)) {
    return CANONICAL_ATTACHMENT_PREFIX + url.slice(LEGACY_ATTACHMENT_PREFIX.length);
  }

  const origin = selfOrigin();
  if (origin) {
    const selfHostLegacyPrefix = `${origin}${LEGACY_ATTACHMENT_PREFIX}`;
    if (url.startsWith(selfHostLegacyPrefix)) {
      return `${origin}${CANONICAL_ATTACHMENT_PREFIX}${url.slice(selfHostLegacyPrefix.length)}`;
    }
  }

  return url;
}
