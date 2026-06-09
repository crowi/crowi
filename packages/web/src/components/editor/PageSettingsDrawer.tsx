'use client';

import { m } from '@paraglide/messages.js';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { GrantSelect } from './GrantSelect';

interface PageSettingsDrawerProps {
  /** Current grant value (Page model constant). */
  grant: number;
  /** Persist a new grant when the user picks one. */
  onChangeGrant: (grant: number) => void;
  /** `true` while a grant mutation is in flight (disables the selector). */
  isGrantSaving?: boolean;
}

/**
 * Bottom drawer that gathers page-scoped editor settings behind one
 * button next to Save. Today it holds only the visibility (grant)
 * selector — which used to live in the editor header — but it is the
 * home for any future per-page setting so the header / footer stay
 * uncluttered. Built on the bottom `Sheet` so it slides up from the
 * bottom edge, which reads well on mobile where the footer Save row
 * lives.
 */
export function PageSettingsDrawer({ grant, onChangeGrant, isGrantSaving = false }: PageSettingsDrawerProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" type="button" aria-label={m['edit.page_settings']()} title={m['edit.page_settings']()}>
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-w-2xl">
        <SheetHeader>
          <SheetTitle>{m['edit.page_settings']()}</SheetTitle>
          <SheetDescription>{m['edit.page_settings_description']()}</SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{m['edit.grant_label']()}</p>
            <p className="text-muted-foreground text-sm">{m['edit.grant_settings_hint']()}</p>
          </div>
          <GrantSelect value={grant} onChange={onChangeGrant} disabled={isGrantSaving} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
