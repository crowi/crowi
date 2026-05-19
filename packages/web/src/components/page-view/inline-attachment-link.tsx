'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { InlineAttachmentModal } from './inline-attachment-modal';

/**
 * Extract an attachment ObjectId from an in-body reference URL.
 *
 * Two URI forms are recognised — the current `/api/v2/attachments/<id>`
 * (the stream route / `fileUrl` virtual) and the legacy `/files/<id>` form
 * still present in bodies saved before the migration. The id must be the
 * whole final path segment (a 24-char hex ObjectId): `…/attachments/<id>`
 * matches, `…/attachments/<id>/extra` does not. A query string or hash is
 * tolerated. Returns the lower-cased id, or `null` when the URL is not an
 * attachment reference.
 */
const ATTACHMENT_URL_RE = /(?:\/api\/v2\/attachments\/|\/files\/)([0-9a-f]{24})(?:[?#].*)?$/i;

export function extractAttachmentId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(ATTACHMENT_URL_RE);
  return match ? match[1].toLowerCase() : null;
}

interface InlineAttachmentContextValue {
  /** Open the shared modal on the given attachment id. */
  openAttachment: (id: string) => void;
}

const InlineAttachmentContext = createContext<InlineAttachmentContextValue | null>(null);

/**
 * Provides a single, shared attachment-detail modal for an entire page body.
 *
 * Each `/api/v2/attachments/<id>` reference in the body renders an
 * `InlineAttachmentLink`, but they all drive ONE modal instance held here —
 * keeping the open attachment id in this provider's state rather than
 * per-link state. Wrap the rendered page body in this provider.
 */
export function InlineAttachmentProvider({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);

  const openAttachment = useCallback((id: string) => setOpenId(id), []);
  const value = useMemo<InlineAttachmentContextValue>(() => ({ openAttachment }), [openAttachment]);

  return (
    <InlineAttachmentContext.Provider value={value}>
      {children}
      <InlineAttachmentModal
        attachmentId={openId}
        open={openId !== null}
        onOpenChange={(o) => {
          if (!o) setOpenId(null);
        }}
      />
    </InlineAttachmentContext.Provider>
  );
}

interface InlineAttachmentLinkProps {
  attachmentId: string;
  /** Render mode: a text link (`[]()`) or an embedded image (`![]()`). */
  variant: 'link' | 'image';
  href: string;
  className?: string;
  children?: React.ReactNode;
  /** `image` variant only. */
  alt?: string;
}

/**
 * In-body attachment reference. Left-click opens the shared detail modal
 * instead of full-page-navigating to the raw file (which truncates the
 * page's streaming-SSR response and breaks Back/Forward restore).
 *
 * - `link` variant: keeps the original link text; renders an `<a>` whose
 *   `href` still points at the raw file (so middle-click / "open in new tab"
 *   / right-click-copy keep working) but whose left-click is intercepted.
 * - `image` variant: keeps showing the image; left-click opens the modal.
 *   Right-click (save image, copy, …) is never intercepted — only a plain
 *   primary-button click with no modifier keys opens the modal.
 *
 * Outside an `InlineAttachmentProvider` it degrades to the plain element.
 */
// A modifier-key or non-primary-button click is left alone so the
// browser's native "open in new tab / window" still works.
const isPlainPrimaryClick = (event: React.MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export function InlineAttachmentLink({ attachmentId, variant, href, className, children, alt }: InlineAttachmentLinkProps) {
  const ctx = useContext(InlineAttachmentContext);

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!ctx || !isPlainPrimaryClick(event)) return;
      event.preventDefault();
      ctx.openAttachment(attachmentId);
    },
    [ctx, attachmentId],
  );

  if (variant === 'image') {
    return (
      // biome-ignore lint/performance/noImgElement: rich-text rendered as plain markdown
      // biome-ignore lint/a11y/noStaticElementInteractions: image embed opens the modal on click
      // biome-ignore lint/a11y/useKeyWithClickEvents: parity with the page-body link below
      <img
        src={href}
        alt={alt || ''}
        className={className}
        loading="lazy"
        onClick={handleClick}
        // Pointer affordance hints the click-to-open behaviour.
        style={{ cursor: 'zoom-in' }}
      />
    );
  }

  return (
    // The href stays the raw-file URL so middle-click / "open in new tab"
    // still reach the file; only a plain left-click is intercepted.
    <a href={href} className={className} onClick={handleClick}>
      {children}
    </a>
  );
}
