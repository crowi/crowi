'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormErrorList } from '@/components/ui/form-error-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { loginWithPassword } from '@/lib/auth-login';
import { buildLoginRedirectUrl } from '@/lib/login-redirect';
import { useSessionReauthRequired } from '@/lib/session-reauth-context';
import { clearTokens } from '@/lib/auth-token';
import { m } from '@paraglide/messages.js';

/**
 * Editor-only inline re-authentication modal.
 *
 * Shown (and only shown) while the `SessionReauthProvider` has
 * `isReauthing === true` — i.e. the shared refresh path failed, so a
 * full re-login is needed. The modal is intentionally **non-dismissible**
 * (no Escape, no backdrop click, no close button): the only ways out are
 *
 *   - "Sign in again" → `loginWithPassword` → `resolveReauth()` refetches
 *     the collab + presence tokens, the editor reconnects, and the Y.Doc /
 *     CodeMirror buffer is never unmounted, so the in-progress edit
 *     survives the round-trip.
 *   - "Discard and go to login" → an explicit, warned destructive route
 *     that wipes tokens and navigates to `/login?continue=…`, accepting
 *     the loss of the unsaved buffer.
 *
 * Multi-tab recovery (another tab re-authenticated) closes this modal via
 * the provider's `storage` listener — no interaction needed here.
 */
export function SessionReauthModal() {
  const router = useRouter();
  const { isReauthing, reauthEmail, resolveReauth } = useSessionReauthRequired();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Pre-fill the email + clear the password/errors when the modal opens.
  // Following the React docs "adjust state when a prop changes" pattern:
  // store the previous open-state in state and reset *during render* on
  // the closed→open transition. This avoids both a synchronous-setState-
  // in-effect cascade and a ref write during render.
  const [wasOpen, setWasOpen] = useState(false);
  if (isReauthing !== wasOpen) {
    setWasOpen(isReauthing);
    if (isReauthing) {
      setEmail(reauthEmail);
      setPassword('');
      setErrors([]);
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrors([]);

    const result = await loginWithPassword(email, password);
    if (result.ok) {
      // Fresh tokens are persisted by `loginWithPassword`. Resolving the
      // context clears `isReauthing` and refetches the collab / presence
      // tokens so both WebSockets reconnect.
      resolveReauth();
    } else {
      setErrors([result.message]);
    }
    setIsSubmitting(false);
  };

  const handleDiscard = () => {
    // Explicit destructive exit: drop tokens and bounce to login,
    // accepting the loss of the unsaved buffer. `continue` returns the
    // user to the same editor URL after they log in (a fresh page load,
    // so the buffer is gone — the warning made that clear).
    clearTokens();
    router.push(buildLoginRedirectUrl(window.location.pathname + window.location.search));
  };

  return (
    <Dialog open={isReauthing}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{m['edit.reauth_title']()}</DialogTitle>
          <DialogDescription>{m['edit.reauth_description']()}</DialogDescription>
        </DialogHeader>

        <FormErrorList errors={errors} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reauth-email">{m['edit.reauth_email_label']()}</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="reauth-email"
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

          <div className="space-y-2">
            <Label htmlFor="reauth-password">{m['edit.reauth_password_label']()}</Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="reauth-password"
                name="password"
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10"
                required
                autoComplete="current-password"
                // Focus the password field on open — email is usually
                // pre-filled, so the user only needs to type the password.
                autoFocus
              />
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                {m['edit.reauth_submitting']()}
              </>
            ) : (
              m['edit.reauth_submit']()
            )}
          </Button>
        </form>

        <div className="border-t pt-4 text-center">
          <p className="text-muted-foreground mb-2 text-xs">{m['edit.reauth_discard_warning']()}</p>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDiscard} type="button" disabled={isSubmitting}>
            {m['edit.reauth_discard']()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
