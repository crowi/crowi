'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Mail, KeyRound, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormErrorList } from '@/components/ui/form-error-list';
import { loginWithPassword } from '@/lib/auth-login';
import { defaultLandingPath, safeContinueUrl } from '@/lib/login-redirect';
import { useAppInfo } from '@/lib/use-app-info';
import { m } from '@paraglide/messages.js';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Raw param so we can distinguish "no continue given" (→ default landing
  // on the user's page) from an explicit `?continue=...` (→ honour it after
  // open-redirect sanitisation).
  const rawContinue = searchParams.get('continue');

  // Hide the "sign up" link when self-service registration is closed
  // (invite-only) so we don't route users to a /register that only shows an
  // invite-only notice. Fail-open: while the flag is loading or if the fetch
  // failed (`canSelfRegister` undefined) the link stays visible — it is only
  // hidden when registration is definitively closed.
  const { data: appInfo } = useAppInfo();
  const showRegisterLink = appInfo?.canSelfRegister !== false;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [formData, setFormData] = useState({
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

    // RFC-0006 Phase 4 Batch 1 — `POST /auth/login` (Hono). The wire
    // format + token persistence live in the shared `loginWithPassword`
    // helper, reused by the editor's inline session-reauth modal.
    const result = await loginWithPassword(formData.email, formData.password);
    if (result.ok) {
      // Explicit `continue` (sanitised) wins; otherwise land the user on
      // their own user page rather than the portal root.
      const destination = rawContinue ? safeContinueUrl(rawContinue) : defaultLandingPath(result.username);
      router.push(destination);
    } else {
      setErrors([result.message]);
    }
    setIsSubmitting(false);
  };

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">{m['auth.login.title']()}</CardTitle>
      </CardHeader>
      <CardContent>
        <FormErrorList errors={errors} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{m['auth.login.email_label']()}</Label>
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
            <Label htmlFor="password">{m['auth.login.password_label']()}</Label>
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
                autoComplete="current-password"
              />
            </div>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? m['auth.login.submitting']() : m['auth.login.submit']()}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <Link href="/forgot-password" className="text-sm text-muted-foreground hover:text-primary hover:underline">
            {m['auth.login.forgot_link']()}
          </Link>
        </div>

        {showRegisterLink && (
          <div className="mt-6 pt-6 border-t text-center">
            <Link href="/register" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <PenLine className="h-4 w-4" />
              {m['auth.login.register_link']()}
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
