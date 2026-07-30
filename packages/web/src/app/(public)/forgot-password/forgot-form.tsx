'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient } from '@/lib/api-client';
import { m } from '@paraglide/messages.js';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await apiClient.auth['forgot-password'].$post({ json: { email } });
      // Anti-enumeration: the API always returns 200; show the same
      // confirmation regardless of whether the email exists.
      if (res.status === 200) {
        setDone(true);
      } else {
        setError(m['auth.forgot.error']());
      }
    } catch {
      setError(m['auth.common.server_error']());
    } finally {
      setIsSubmitting(false);
    }
  };

  if (done) {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.forgot.check_email_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{m['auth.forgot.check_email_body']()}</AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {m['auth.common.back_to_signin']()}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">{m['auth.forgot.title']()}</CardTitle>
        <CardDescription className="text-center">{m['auth.forgot.lead']()}</CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{m['auth.forgot.email_label']()}</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="E-mail"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-10"
                required
                autoComplete="email"
              />
            </div>
          </div>
          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? m['auth.forgot.submitting']() : m['auth.forgot.submit']()}
          </Button>
        </form>
        <div className="mt-6 pt-6 border-t text-center">
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" />
            {m['auth.common.back_to_signin']()}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
