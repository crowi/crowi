'use client';

import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface CommentFormProps {
  isSubmitting: boolean;
  error: Error | null;
  onSubmit: (comment: string) => Promise<void> | void;
}

export function CommentForm({ isSubmitting, error, onSubmit }: CommentFormProps) {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Local validation / catch errors take precedence over the external mutation error.
  const displayError = localError ?? error?.message ?? null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setLocalError('Comment cannot be empty');
      return;
    }
    setLocalError(null);
    try {
      await onSubmit(trimmed);
      setValue('');
    } catch (err) {
      // Handled via the `error` prop, but keep a fallback for defensive behavior.
      const message = err instanceof Error ? err.message : 'Failed to post comment';
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
        placeholder="Write a comment..."
        disabled={isSubmitting}
        rows={3}
        aria-label="Comment body"
      />
      {displayError && (
        <p className="text-sm text-destructive" role="alert">
          {displayError}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isSubmitting || !value.trim()}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {isSubmitting ? 'Posting...' : 'Post comment'}
        </Button>
      </div>
    </form>
  );
}
