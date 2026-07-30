'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AtSign, User, Mail, KeyRound, LogIn, MailCheck, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormErrorList } from '@/components/ui/form-error-list';
import { apiClient } from '@/lib/api-client';
import { errorMessage } from '@/lib/error-message';
import { useAppInfo } from '@/lib/use-app-info';
import { m } from '@paraglide/messages.js';

export function RegisterForm() {
  // Public UX hint: when self-service registration is closed (invite-only)
  // we show an explanatory card instead of the form, so the user isn't led
  // to fill it in only to hit a 403. While the flag is loading we render a
  // skeleton; if the fetch fails we fail-open and show the form (the API
  // still enforces the real guard on submit). Reuses the shared /app/info
  // query the login / register pages already issue for the site title.
  const { data: appInfo, isLoading: isAppInfoLoading } = useAppInfo();
  const registrationClosed = appInfo?.canSelfRegister === false;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState<'confirmation_required' | 'approval_required' | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    name: '',
    email: '',
    password: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrors([]);

    try {
      // RFC-0006 Phase 4 Batch 1 — switched from
      // `apiClient.tokenAuth.tokenRegister` to
      // `apiClient.auth.register.$post`. Wire format unchanged.
      const response = await apiClient.auth.register.$post({
        json: {
          username: formData.username,
          name: formData.name,
          email: formData.email,
          password: formData.password,
        },
      });

      if (response.status === 200) {
        // Self-registration no longer auto-signs-in: the account is
        // pending email confirmation (open) or admin approval (restricted).
        const body = await response.json();
        setPending(body.status);
      } else if (response.status === 400 || response.status === 403 || response.status === 409 || response.status === 503) {
        const body = await response.json();
        setErrors([errorMessage(body.error?.code, body.error?.message || m['auth.register.error']())]);
      } else {
        setErrors([m['auth.register.unexpected_error']()]);
      }
    } catch {
      setErrors([m['auth.common.server_error']()]);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Still resolving whether registration is open: render a lightweight
  // skeleton so the form doesn't flash before we know to hide it. On a
  // fetch error `isLoading` is already false (status is mutually exclusive),
  // so we fall through and show the form (fail-open).
  if (isAppInfoLoading) {
    return (
      <Card className="shadow-2xl">
        <CardContent className="p-6 animate-pulse space-y-4">
          <div className="h-6 bg-muted rounded w-1/3 mx-auto" />
          <div className="h-10 bg-muted rounded" />
          <div className="h-10 bg-muted rounded" />
          <div className="h-10 bg-muted rounded" />
          <div className="h-10 bg-muted rounded" />
          <div className="h-12 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  // Self-service registration is closed (invite-only): show an explanatory
  // card with a way back to sign in instead of the form. Same Card pattern
  // as the post-submit `pending` state. The /register route is not
  // redirected so a direct visit still explains what happened.
  if (registrationClosed) {
    return (
      <Card className="shadow-2xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl text-center">{m['auth.register.closed_title']()}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Lock className="h-4 w-4" />
            <AlertDescription>{m['auth.register.closed_body']()}</AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <LogIn className="h-4 w-4" />
            {m['auth.common.back_to_signin']()}
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (pending) {
    return (
      <Card className="shadow-2xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl text-center">
            {pending === 'confirmation_required' ? m['auth.register.pending_confirm_title']() : m['auth.register.pending_approval_title']()}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <MailCheck className="h-4 w-4" />
            <AlertDescription>
              {pending === 'confirmation_required'
                ? m['auth.register.pending_confirm_body']({ email: formData.email })
                : m['auth.register.pending_approval_body']()}
            </AlertDescription>
          </Alert>
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <LogIn className="h-4 w-4" />
            {m['auth.common.back_to_signin']()}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">{m['auth.register.title']()}</CardTitle>
        <CardDescription className="text-center">{m['auth.register.lead']()}</CardDescription>
      </CardHeader>
      <CardContent>
        <FormErrorList errors={errors} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">{m['auth.register.userid_label']()}</Label>
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="username"
                name="username"
                type="text"
                placeholder={m['auth.register.userid_placeholder']()}
                value={formData.username}
                onChange={handleChange}
                className="pl-10"
                required
                autoComplete="username"
              />
            </div>
            <p className="text-xs text-muted-foreground">{m['auth.register.userid_help']()}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">{m['auth.register.name_label']()}</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="name"
                name="name"
                type="text"
                placeholder={m['auth.register.name_placeholder']()}
                value={formData.name}
                onChange={handleChange}
                className="pl-10"
                required
                autoComplete="name"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">{m['auth.register.email_label']()}</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="E-mail"
                value={formData.email}
                onChange={handleChange}
                className="pl-10"
                required
                autoComplete="email"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{m['auth.register.password_label']()}</Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="Password"
                value={formData.password}
                onChange={handleChange}
                className="pl-10"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
            <p className="text-xs text-muted-foreground">{m['auth.register.password_help']()}</p>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? m['auth.register.submitting']() : m['auth.register.submit']()}
          </Button>
        </form>

        <div className="mt-6 pt-6 border-t text-center">
          <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <LogIn className="h-4 w-4" />
            {m['auth.register.to_signin']()}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
