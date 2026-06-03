'use client';

import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { m } from '@paraglide/messages.js';

interface CommentFormProps {
  isSubmitting: boolean;
  error: Error | null;
  onSubmit: (comment: string) => Promise<void> | void;
  /** When true (no comments yet), invite the user to write the page's first comment. */
  isFirstComment?: boolean;
}

export function CommentForm({ isSubmitting, error, onSubmit, isFirstComment = false }: CommentFormProps) {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Local validation / catch errors take precedence over the external mutation error.
  const displayError = localError ?? error?.message ?? null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setLocalError(m['page_comments.empty_form_error']());
      return;
    }
    setLocalError(null);
    try {
      await onSubmit(trimmed);
      setValue('');
    } catch (err) {
      // Handled via the `error` prop, but keep a fallback for defensive behavior.
      const message = err instanceof Error ? err.message : m['page_comments.failed_to_post']();
      setLocalError(message);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (localError) setLocalError(null);
        }}
        placeholder={isFirstComment ? m['page_comments.placeholder_first']() : m['page_comments.placeholder']()}
        disabled={isSubmitting}
        rows={3}
        aria-label={m['page_comments.body_aria']()}
      />
      {displayError && (
        <p className="text-sm text-destructive" role="alert">
          {displayError}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isSubmitting || !value.trim()}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {isSubmitting ? m['page_comments.posting']() : m['page_comments.post']()}
        </Button>
      </div>
    </form>
  );
}
