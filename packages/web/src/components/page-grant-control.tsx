'use client';

import { PageGrantEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { type RefObject, useRef } from 'react';
import { GrantSelect } from '@/components/editor/grant-select';
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
import { useForceCloseable } from '@/lib/use-force-closeable';
import type { PageGrantController } from '@/lib/use-page-grant-control';

export interface PageGrantControlProps {
  controller: PageGrantController;
  appearance: 'select' | 'chip';
  /** Only the one active copy renders the confirmation dialog and inline error. */
  active: boolean;
  /** Closes the menu and confirmation hand-off when the host stops being interactive (compact switch, viewport switch). */
  forceClose?: boolean;
  /** Where focus lands when a forced close would otherwise return it to a hidden trigger. */
  focusFallbackRef?: RefObject<HTMLElement | null>;
}

export function PageGrantControl({ controller, appearance, active, forceClose = false, focusFallbackRef }: PageGrantControlProps) {
  const [open, setOpen] = useForceCloseable(forceClose || !active);
  // A pick that needs confirmation closes the Select and then opens the
  // dialog; Radix would otherwise move focus back to the trigger in between
  // and steal it from the dialog's Cancel button.
  const handingOffRef = useRef(false);

  const handleChange = (grant: number) => {
    // Mirrors requestChange's own early returns: only a pick that will really
    // open the confirmation dialog hands focus off.
    if (!controller.disabled && controller.currentGrant === PageGrantEnum.SPECIFIED && grant !== PageGrantEnum.SPECIFIED) handingOffRef.current = true;
    void controller.requestChange(grant);
  };

  const handleCloseAutoFocus = (event: Event) => {
    if (handingOffRef.current) {
      handingOffRef.current = false;
      event.preventDefault();
      return;
    }
    if (forceClose || !active) {
      event.preventDefault();
      focusFallbackRef?.current?.focus();
    }
  };

  const confirmation = active ? controller.confirmation : null;

  return (
    <>
      <span className="inline-flex shrink-0 items-center gap-2" aria-busy={controller.isSaving || undefined}>
        <GrantSelect
          value={controller.currentGrant}
          onChange={handleChange}
          disabled={controller.disabled}
          appearance={appearance}
          open={open}
          onOpenChange={setOpen}
          onCloseAutoFocus={handleCloseAutoFocus}
        />
        {controller.isSaving && <span className="sr-only">{m['edit.grant_saving']()}</span>}
        {appearance === 'chip' && active && controller.error != null && (
          <span role="alert" className="text-destructive text-xs">
            {controller.error}
          </span>
        )}
      </span>
      {confirmation != null && (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next) controller.cancelConfirmation();
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m['edit.grant_specified_reset_title']()}</AlertDialogTitle>
              <AlertDialogDescription>{m['edit.grant_specified_reset_description']()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{m['common.cancel']()}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void controller.confirmChange()}>{m['edit.grant_confirm_change']()}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
