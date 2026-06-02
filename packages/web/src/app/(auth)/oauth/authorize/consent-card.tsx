'use client';

import { ShieldCheck } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Human label for a single requested scope, grouped by read / write. */
function scopeLabel(scope: string): string {
  if (scope === 'read') return m['oauth.consent.scope_umbrella_read']();
  if (scope === 'write') return m['oauth.consent.scope_umbrella_write']();
  const [, action] = scope.split(':');
  return action === 'write' ? m['oauth.consent.scope_write']() : m['oauth.consent.scope_read']();
}

interface ConsentCardProps {
  clientName: string;
  scopes: string[];
  error: string | null;
  isApproving: boolean;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * Presentational consent card (RFC-0010 Phase 3). v1 consent is
 * all-or-nothing (PHASE3-Q8): the requested scopes are displayed for
 * transparency and the user either authorizes the whole set or cancels.
 */
export function ConsentCard({ clientName, scopes, error, isApproving, onApprove, onDeny }: ConsentCardProps) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-[var(--crowi-primary)]" />
          <CardTitle>{m['oauth.consent.title']()}</CardTitle>
        </div>
        <CardDescription>{m['oauth.consent.lead']({ client: clientName })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">{m['oauth.consent.scopes_heading']()}</p>
          <ul className="divide-y rounded-md border">
            {scopes.map((scope) => (
              <li key={scope} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                <span className="font-mono">{scope}</span>
                <span className="text-muted-foreground">{scopeLabel(scope)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDeny} disabled={isApproving}>
            {m['oauth.consent.deny']()}
          </Button>
          <Button type="button" onClick={onApprove} disabled={isApproving || scopes.length === 0}>
            {isApproving ? m['oauth.consent.approving']() : m['oauth.consent.approve']()}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
