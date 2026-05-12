'use client';

import { useRef } from 'react';
import { Loader2, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAddAttachment } from '@/lib/use-attachments';
import type { Attachment } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface AttachmentInsertButtonProps {
  /**
   * The page id to attach to. `null` disables the button — used in
   * create-mode where the page hasn't been saved yet (the API only
   * attaches to existing pages, so the operator must save first).
   */
  pageId: string | null;
  /** Called with the markdown snippet to insert at the cursor on success. */
  onInsert: (snippet: string) => void;
  /** Called when an upload fails so the parent can surface the message. */
  onError: (message: string) => void;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Minimal file-attach affordance for the page editor: a button that
 * opens a file picker, uploads the selected file via the existing
 * attachments API, and inserts a markdown snippet at the textarea
 * cursor on success. Drag-and-drop / inline image rendering / preview
 * are deliberately out of scope for v2.0 — those land with the
 * planned editor refresh.
 */
export function AttachmentInsertButton({ pageId, onInsert, onError }: AttachmentInsertButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useAddAttachment(pageId ?? undefined);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input so picking the same file twice still fires onChange.
    event.target.value = '';
    if (!file || !pageId) return;

    if (file.size > MAX_FILE_BYTES) {
      onError(m['edit.attach_too_large']({ limit: '5 MB' }));
      return;
    }

    try {
      const attachment: Attachment = await upload.mutateAsync(file);
      onInsert(buildSnippet(attachment));
    } catch (err) {
      onError(err instanceof Error ? err.message : m['edit.attach_failed']());
    }
  };

  const disabled = pageId === null || upload.isPending;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={disabled}
        title={pageId === null ? m['edit.attach_save_first']() : m['edit.attach_button']()}
      >
        {upload.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Paperclip className="h-4 w-4 mr-1" />}
        {m['edit.attach_button']()}
      </Button>
      <input ref={inputRef} type="file" className="hidden" onChange={handleChange} aria-hidden="true" />
    </>
  );
}

/**
 * Markdown snippet inserted at the cursor. Images get the `![]()`
 * form so they render inline; other types get a plain `[](url)` link.
 */
function buildSnippet(attachment: Attachment): string {
  const isImage = typeof attachment.fileFormat === 'string' && attachment.fileFormat.startsWith('image/');
  const label = attachment.originalName || 'file';
  const url = attachment.url;
  return isImage ? `![${label}](${url})` : `[${label}](${url})`;
}
