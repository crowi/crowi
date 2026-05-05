'use client';

import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

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
export function ErrorAlert({ title = 'Error', message = 'Please try again later.', onRetry, retryLabel = 'Retry' }: ErrorAlertProps) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {message}
        {onRetry && (
          <Button variant="outline" size="sm" className="ml-4" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
