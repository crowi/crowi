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
import { buildProviderStartUrl } from '@/lib/auth-handoff';
import { defaultLandingPath, safeContinueUrl } from '@/lib/login-redirect';
import { useAppInfo } from '@/lib/use-app-info';
import { useAuthProviders } from '@/lib/use-auth-providers';
import { m } from '@paraglide/messages.js';

/**
 * The federated failures worth naming. Everything else the callback can
 * report (`idp_error`, `invalid_state`, `exchange_failed`,
 * `oidc_verification_failed`, `profile_rejected`,
 * `registration_unavailable`) is a protocol or infrastructure fault the
 * visitor can neither diagnose nor act on, so it collapses into the
 * generic message rather than putting an internal code in front of them.
 */
const FEDERATED_ERROR_MESSAGES: Record<string, () => string> = {
  registration_closed: () => m['auth.login.federated_error.registration_closed'](),
  email_already_registered: () => m['auth.login.federated_error.email_already_registered'](),
  email_not_allowed: () => m['auth.login.federated_error.email_not_allowed'](),
  account_inactive: () => m['auth.login.federated_error.account_inactive'](),
};

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

  // Federated sign-in buttons (RFC-0014 phase 4). Fail-closed, unlike the
  // register link above: while the list is loading or the fetch failed,
  // no provider button is drawn. A button that cannot be trusted to
  // reach a configured provider is worse than no button — password
  // sign-in below always works.
  const { data: authProviders } = useAuthProviders();
  const [startingProvider, setStartingProvider] = useState<string | null>(null);

  // A federated sign-in that failed anywhere between `/start` and the
  // callback comes back here as `?error=<code>` — there is no response
  // body to read, so the URL is the only account of what went wrong.
  const federatedError = searchParams.get('error');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>(
    federatedError ? [(FEDERATED_ERROR_MESSAGES[federatedError] ?? (() => m['auth.login.federated_error.generic']()))()] : [],
  );
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  // Not a plain `<a href>`: the phase-1 `/start` contract requires a
  // sender proof (`handoff_jwk` + `handoff_proof`) that has to be
  // generated and signed in this browser first, so the URL only exists
  // after an async step. Once built we hand over with a full-page
  // navigation — the flow leaves the SPA for the identity provider.
  const handleProviderClick = async (provider: string) => {
    setStartingProvider(provider);
    setErrors([]);
    try {
      window.location.assign(await buildProviderStartUrl(provider, safeContinueUrl(rawContinue)));
    } catch {
      setErrors([m['auth.providers.load_failed']()]);
      setStartingProvider(null);
    }
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

        {authProviders && authProviders.length > 0 && (
          <div className="mt-6 space-y-3">
            <div className="relative text-center">
              <span className="absolute inset-x-0 top-1/2 border-t" />
              <span className="relative bg-card px-2 text-xs text-muted-foreground">{m['auth.providers.divider']()}</span>
            </div>
            {authProviders.map((provider) => (
              <Button
                key={provider.name}
                type="button"
                variant="outline"
                className="w-full"
                size="lg"
                disabled={startingProvider !== null}
                onClick={() => handleProviderClick(provider.name)}
              >
                {provider.iconUrl && <img src={provider.iconUrl} alt="" aria-hidden className="h-4 w-4" />}
                {provider.buttonLabel}
              </Button>
            ))}
          </div>
        )}

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
