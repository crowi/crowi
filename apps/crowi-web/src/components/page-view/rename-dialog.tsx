'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageRevisionConflictError, useRenamePage } from '@/lib/use-page-mutations';
import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface RenameDialogProps {
  page: PageWithRevision;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Feedback = { kind: 'conflict' | 'error'; message: string };

function isValidPath(path: string): boolean {
  if (!path) return false;
  if (!path.startsWith('/')) return false;
  return true;
}

/**
 * Outer wrapper: keeps the dialog mounted at all times but unmounts the form
 * when closed. This guarantees that internal form state is fresh on every open
 * (so we don't need a useEffect to reset it).
 */
export function RenameDialog({ page, open, onOpenChange }: RenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <RenameDialogForm page={page} onOpenChange={onOpenChange} />}</DialogContent>
    </Dialog>
  );
}

interface RenameDialogFormProps {
  page: PageWithRevision;
  onOpenChange: (open: boolean) => void;
}

function RenameDialogForm({ page, onOpenChange }: RenameDialogFormProps) {
  const router = useRouter();
  const renameMutation = useRenamePage();

  const [newPath, setNewPath] = useState(page.path);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const isSubmitting = renameMutation.isPending;
  const isUnchanged = newPath === page.path;
  const isInvalid = !isValidPath(newPath);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || isUnchanged || isInvalid) return;

    setFeedback(null);

    try {
      const updated = await renameMutation.mutateAsync({
        page_id: page._id,
        new_path: newPath,
        revision_id: page.revision._id,
        // Match legacy behaviour: always create a redirect page from the old path.
        create_redirect: true,
      });

      onOpenChange(false);
      router.replace(updated.path);
    } catch (err) {
      if (err instanceof PageRevisionConflictError) {
        setFeedback({ kind: 'conflict', message: err.message });
        return;
      }
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : m['page.rename.failed'](),
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{m['page.rename.title']()}</DialogTitle>
        <DialogDescription>{m['page.rename.description']()}</DialogDescription>
      </DialogHeader>

      {feedback && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{feedback.kind === 'conflict' ? m['page.rename.conflict_title']() : m['page.rename.error_title']()}</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="rename-current-path">{m['page.rename.current_path']()}</Label>
        <Input id="rename-current-path" value={page.path} readOnly className="font-mono text-sm bg-muted" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="rename-new-path">{m['page.rename.new_path']()}</Label>
        <Input
          id="rename-new-path"
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
          disabled={isSubmitting}
          placeholder={m['page.rename.placeholder']()}
          className="font-mono text-sm"
          autoFocus
          aria-invalid={isInvalid && newPath.length > 0 ? true : undefined}
        />
        {isInvalid && newPath.length > 0 && <p className="text-xs text-destructive">{m['page.rename.invalid_path']()}</p>}
      </div>

      <DialogFooter className="gap-2 sm:gap-0">
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={isSubmitting}>
            {m['page.rename.cancel']()}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={isSubmitting || isUnchanged || isInvalid}>
          {isSubmitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {m['page.rename.submit']()}
        </Button>
      </DialogFooter>
    </form>
  );
}
