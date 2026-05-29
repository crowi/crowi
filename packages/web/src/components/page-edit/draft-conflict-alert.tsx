'use client';

import { m } from '@paraglide/messages.js';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface DraftConflictAlertProps {
  displayName: string;
  username: string;
}

/**
 * "This path is being created by <user>" conflict alert, shared by the
 * `/_edit?path=` create flow and the `/me/creating-pages` new-draft form.
 * The user reference links to the owner's user page (`/user/<username>`)
 * so you can reach out to them. The message is split into before / user /
 * after i18n segments because the linked text sits mid-sentence and the
 * word order differs across locales.
 */
export function DraftConflictAlert({ displayName, username }: DraftConflictAlertProps) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{m['creating_pages.conflict_title']()}</AlertTitle>
      <AlertDescription>
        <span>
          {m['creating_pages.conflict_message_before']()}
          <Link href={`/user/${username}`} className="font-medium underline underline-offset-2">
            {m['creating_pages.conflict_user']({ displayName, username })}
          </Link>
          {m['creating_pages.conflict_message_after']()}
        </span>
      </AlertDescription>
    </Alert>
  );
}
