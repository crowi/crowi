'use client';

import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { m } from '@paraglide/messages.js';

interface ErrorAlertProps {
  title?: string;
  message?: string;
  /** When set, renders a "Retry" button next to the message. */
  onRetry?: () => void;
  retryLabel?: string;
}

/**
 * Generic destructive Alert used for "failed to load X" type errors.
 * Optionally renders a retry button inline.
 */
export function ErrorAlert({ title, message, onRetry, retryLabel }: ErrorAlertProps) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title ?? m['common.error']()}</AlertTitle>
      <AlertDescription>
        {message ?? m['common.try_again_later']()}
        {onRetry && (
          <Button variant="outline" size="sm" className="ml-4" onClick={onRetry}>
            {retryLabel ?? m['common.retry']()}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
