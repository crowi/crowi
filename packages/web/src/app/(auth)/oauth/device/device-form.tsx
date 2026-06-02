'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface DeviceFormProps {
  /** Prefill value from `verification_uri_complete` (`?user_code=`). */
  initialUserCode: string;
  error: string | null;
  isSubmitting: boolean;
  onSubmit: (userCode: string) => void;
}

/**
 * RFC-0010 Phase 4 — `user_code` entry form (RFC 8628 device flow). The user
 * either lands here pre-filled via `verification_uri_complete` or types the
 * `ABCD-1234` code shown by the CLI, then continues to the consent step.
 */
export function DeviceForm({ initialUserCode, error, isSubmitting, onSubmit }: DeviceFormProps) {
  const [userCode, setUserCode] = useState(initialUserCode);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(userCode);
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-5 text-[var(--crowi-primary)]" />
          <CardTitle>{m['oauth.device.title']()}</CardTitle>
        </div>
        <CardDescription>{m['oauth.device.lead']()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="user_code">{m['oauth.device.code_label']()}</Label>
            <Input
              id="user_code"
              name="user_code"
              value={userCode}
              onChange={(e) => setUserCode(e.target.value)}
              placeholder="ABCD-1234"
              autoComplete="off"
              autoCapitalize="characters"
              className="font-mono tracking-widest"
            />
          </div>
          <div className="flex justify-end pt-2">
            <Button type="submit" disabled={isSubmitting || userCode.trim().length === 0}>
              {isSubmitting ? m['oauth.device.continuing']() : m['oauth.device.continue']()}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
