'use client';

import { Lock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { m } from '@paraglide/messages.js';

interface AccessDeniedCardProps {
  title?: string;
  description?: string;
  body?: string;
  /** Renders a "Go Back" button when provided (typically `() => router.back()`). */
  onGoBack?: () => void;
  goBackLabel?: string;
}

/**
 * Amber-bordered card used when the current user lacks permission to view
 * a page (403). Shared across page-view, id-redirector, and page-history.
 */
export function AccessDeniedCard({ title, description, body, onGoBack, goBackLabel }: AccessDeniedCardProps) {
  return (
    <Card className="border-amber-200 dark:border-amber-800">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-amber-500" />
          <CardTitle>{title ?? m['common.access_denied_title']()}</CardTitle>
        </div>
        <CardDescription>{description ?? m['common.access_denied_description']()}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground">{body ?? m['common.access_denied_body']()}</p>
        {onGoBack && (
          <div className="mt-4">
            <Button variant="outline" onClick={onGoBack}>
              {goBackLabel ?? m['common.go_back']()}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
