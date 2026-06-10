'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { m } from '@paraglide/messages.js';

/**
 * Route-segment error boundary (App Router). Renders when a Client/Server
 * Component below the root layout throws during render, replacing the
 * production white-screen with a themed error card + `reset()` retry.
 *
 * This boundary lives *inside* the providers/locale bridge, so it renders
 * after hydration and Paraglide's `m['*']()` lookups resolve to the active
 * locale safely (unlike `global-error.tsx`, which can lose that context).
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface the digest so it's discoverable in the browser console even in
    // production builds where the message is otherwise scrubbed.
    console.error('Route segment error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-destructive h-5 w-5" />
            <CardTitle>{m['errors.unexpected_title']()}</CardTitle>
          </div>
          <CardDescription>{m['errors.unexpected_body']()}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={reset}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {m['common.reload']()}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
