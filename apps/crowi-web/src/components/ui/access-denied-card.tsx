'use client';

import { Lock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

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
export function AccessDeniedCard({
  title = 'Access Denied',
  description = 'You do not have permission to view this page.',
  body = 'This page is private or you need to be granted access by the owner.',
  onGoBack,
  goBackLabel = 'Go Back',
}: AccessDeniedCardProps) {
  return (
    <Card className="border-amber-200 dark:border-amber-800">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-amber-500" />
          <CardTitle>{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground">{body}</p>
        {onGoBack && (
          <div className="mt-4">
            <Button variant="outline" onClick={onGoBack}>
              {goBackLabel}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
