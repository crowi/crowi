'use client';

import { useAttachment } from '@/lib/use-attachments';
import { AttachmentDetailModal } from './attachment-detail-modal';
import type { Attachment } from '@crowi/api-contract';

interface InlineAttachmentModalProps {
  /** Attachment id to fetch + display, or `null` to keep the modal closed. */
  attachmentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const noopDelete = () => Promise.resolve();

/**
 * Id-fetching wrapper around `AttachmentDetailModal` for in-body attachment
 * references.
 *
 * `AttachmentDetailModal` (Phase 6) was built for the page-footer list and
 * receives a fully-resolved `Attachment` object. A `/api/attachments/<id>`
 * link / embed in a page body carries only the id, so this wrapper fetches
 * the metadata via `useAttachment(id)` (react-query, `attachmentsKeys.detail`
 * — repeated body references share one fetch) and hands the modal a resolved
 * attachment once it is available.
 *
 * `AttachmentMeta` omits the page-scoped `inUse` flag; the detail modal never
 * reads it, so we bridge to `Attachment` with `inUse: false`. Deletion is not
 * offered from a body reference — that belongs to the dedicated attachment
 * list / usage views — so `canDelete` is `false`.
 */
export function InlineAttachmentModal({ attachmentId, open, onOpenChange }: InlineAttachmentModalProps) {
  const { data: meta } = useAttachment(attachmentId ?? undefined);

  // Until the metadata resolves there is nothing to render. The modal opens
  // once `meta` arrives — on a warm react-query cache this is synchronous.
  if (!meta) return null;

  const attachment: Attachment = { ...meta, inUse: false };

  return <AttachmentDetailModal attachment={attachment} open={open} onOpenChange={onOpenChange} canDelete={false} onDelete={noopDelete} isDeleting={false} />;
}
