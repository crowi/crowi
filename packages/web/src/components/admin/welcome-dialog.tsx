'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PartyPopper } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { m } from '@paraglide/messages.js';

/**
 * Post-install celebration modal shown on the admin dashboard when the
 * installer redirects here with `?welcome=installed`. The query param is
 * the single source of truth so the modal is a one-shot: closing it (or
 * the initial open effect) strips the param via `router.replace('/admin')`,
 * so a manual reload won't re-trigger it.
 */
export function WelcomeDialog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isWelcome = searchParams.get('welcome') === 'installed';
  // Open state is seeded from the param at mount; the installer always
  // lands here with a fresh navigation, so there's no need for an effect
  // to react to later param changes (closing strips the param entirely).
  const [open, setOpen] = useState(isWelcome);

  const handleClose = () => {
    setOpen(false);
    if (isWelcome) router.replace('/admin');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PartyPopper className="h-5 w-5 text-primary" />
            {m['admin.welcome.dialog_title']()}
          </DialogTitle>
          <DialogDescription>{m['admin.welcome.dialog_body']()}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleClose}>{m['admin.welcome.dialog_close']()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
