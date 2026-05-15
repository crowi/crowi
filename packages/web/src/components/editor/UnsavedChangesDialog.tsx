'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { m } from '@paraglide/messages.js';

interface UnsavedChangesDialogProps {
  open: boolean;
  /** Called when the user dismisses the dialog (keeps editing). */
  onOpenChange: (open: boolean) => void;
  /** Triggers the parent's save flow — caller closes the dialog on success. */
  onSave: () => void;
  /** Discards changes and runs the original cancel/navigate action. */
  onDiscard: () => void;
  /** Disables the Save action while a save is already in flight. */
  isSaving?: boolean;
}

/**
 * Three-way confirmation shown when the user tries to leave the edit
 * screen with uncommitted changes. Mirrors the standard "Save / Discard
 * / Cancel" pattern operators expect from native apps.
 *
 *   - Save     → forwards to the parent's normal save handler. We
 *                deliberately leave the dialog open while a save is in
 *                flight (parent gets to navigate on success, surface
 *                feedback on failure).
 *   - Discard  → fires the parent's `onDiscard` (= the navigation it
 *                originally wanted to perform) without saving.
 *   - Cancel   → closes the dialog and leaves the user on the editor
 *                with their unsaved buffer intact. Same effect as
 *                clicking the backdrop or pressing Escape.
 */
export function UnsavedChangesDialog({ open, onOpenChange, onSave, onDiscard, isSaving = false }: UnsavedChangesDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m['edit.unsaved_title']()}</AlertDialogTitle>
          <AlertDialogDescription>{m['edit.unsaved_description']()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="sm:justify-between">
          <AlertDialogCancel disabled={isSaving}>{m['edit.unsaved_action_keep_editing']()}</AlertDialogCancel>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onDiscard} disabled={isSaving} type="button">
              {m['edit.unsaved_action_discard']()}
            </Button>
            <AlertDialogAction onClick={onSave} disabled={isSaving}>
              {m['edit.unsaved_action_save']()}
            </AlertDialogAction>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
