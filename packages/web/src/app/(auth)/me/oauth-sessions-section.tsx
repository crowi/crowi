'use client';

import { useState } from 'react';
import { Globe, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useDeleteOAuthSession, useOAuthSessions } from '@/lib/use-oauth-sessions';
import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';

export function OAuthSessionsSection() {
  const dateLocale = getLocale() === 'ja' ? 'ja-JP' : 'en-US';
  const { data, isLoading, error: fetchError } = useOAuthSessions();
  const deleteSession = useDeleteOAuthSession();

  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Mutation state is never the display source of truth (see
  // `use-oauth-sessions.ts`'s doc comment): every settle — success, 404,
  // or failure — invalidates the list, and `data` above (the refetch) is
  // the only thing this component renders rows from.
  const handleDelete = async (id: string) => {
    setDeleteError(null);
    try {
      await deleteSession.mutateAsync(id);
    } catch {
      setDeleteError(m['me.oauth_sessions.revoke_failed']());
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{m['me.oauth_sessions.fetch_failed']()}</AlertDescription>
      </Alert>
    );
  }

  const sessions = data?.oauthSessions ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{m['me.oauth_sessions.web_session_excluded']()}</p>
        <p>{m['me.oauth_sessions.last_refreshed_help']()}</p>
        <p>{m['me.oauth_sessions.access_token_ttl_notice']()}</p>
        <p>{m['me.oauth_sessions.rotation_notice']()}</p>
      </div>

      {deleteError && (
        <Alert variant="destructive">
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      )}

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">{m['me.oauth_sessions.empty']()}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-start justify-between gap-4 p-4">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium truncate">{session.clientName}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">{m['me.oauth_sessions.scopes']()}:</span>
                  {session.scopes.map((scope) => (
                    <span key={scope} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {scope}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {m['me.oauth_sessions.authorized_at']({ date: new Date(session.authorizedAt).toLocaleString(dateLocale) })}
                  {' · '}
                  {m['me.oauth_sessions.last_refreshed_at']({ date: new Date(session.lastRefreshedAt).toLocaleString(dateLocale) })}
                  {' · '}
                  {m['me.oauth_sessions.expires_at']({ date: new Date(session.expiresAt).toLocaleString(dateLocale) })}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" size="icon" title={m['me.oauth_sessions.revoke']()}>
                    <Trash2 className="size-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{m['me.oauth_sessions.revoke_dialog_title']()}</AlertDialogTitle>
                    <AlertDialogDescription>{m['me.oauth_sessions.revoke_dialog_warn']({ clientName: session.clientName })}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{m['me.oauth_sessions.revoke_dialog_cancel']()}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleDelete(session.id)}>{m['me.oauth_sessions.revoke_dialog_confirm']()}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
