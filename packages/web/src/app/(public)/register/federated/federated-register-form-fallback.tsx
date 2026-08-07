'use client';

import { m } from '@paraglide/messages.js';
import { LogIn } from 'lucide-react';
import Link from 'next/link';
import { cancelFederatedRegistration } from '@/lib/federated-registration-cancel';

/**
 * AC-2 requires every click on this link to ACTUALLY invalidate the pending
 * grant + clear local tokens before leaving — not merely LOOK clickable.
 * This is its own small client component — not inlined in `page.tsx`, a
 * Server Component that exports `metadata` (Client Components cannot) — so
 * it can render as the OUTER Suspense `fallback`, shown before
 * `FederatedRegisterForm` (a client component reading `useSearchParams()`)
 * has hydrated.
 *
 * `href` is a PERMANENT, inert `#` — never `/login` — rather than a real
 * destination reachable by native browser navigation. Before hydration, no
 * `onClick` handler exists in the real DOM at all (event listeners are only
 * attached once this component's own script has actually run): if `href`
 * pointed at `/login` from the very first paint ("progressive enhancement"
 * — this component briefly used exactly that shape, then a race-condition
 * review pass elsewhere in this phase asked to restore it AGAIN without
 * re-deriving the reasoning below; reverted a second time with this comment
 * expanded so the tradeoff survives review noise), a click landing in that
 * window would follow the browser's native navigation straight there,
 * skipping the cancellation entirely and leaving the grant live while
 * looking, to the visitor, exactly like a successful logout — indistinguishable
 * from success, and NOT retryable (the visitor believes they already left).
 * With a permanent `href="#"`, that SAME pre-hydration click is a same-page
 * no-op instead — nothing to silently skip; the visitor can simply click
 * again once the page has finished loading (typically well under a second).
 * ALL real navigation happens exclusively inside `handleLogout` below
 * (`window.location.href = '/login'`), only reachable once this component's
 * own script has actually run and attached the click handler — so a click
 * either does nothing (pre-hydration) or runs the full cancel-then-leave
 * sequence (post-hydration); there is no third, in-between outcome where
 * cancellation is silently skipped. See `page.test.tsx` for the tests
 * pinning both the `href="#"` markup (SSR and mounted) and the
 * cancel-then-navigate click behavior.
 *
 * The `token` query param is read directly from `window.location.search`
 * (NOT `useSearchParams()`) specifically so this component itself never
 * suspends on the same hook that put `FederatedRegisterForm` behind this
 * Suspense boundary in the first place — it only needs the value at CLICK
 * time, not at render time.
 */
export function FederatedRegisterFormFallback() {
  const handleLogout = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const token = new URLSearchParams(window.location.search).get('token');
    await cancelFederatedRegistration(token);
    window.location.href = '/login';
  };

  return (
    <div className="bg-card rounded-lg shadow-2xl p-6 animate-pulse">
      <div className="h-6 bg-muted rounded w-1/3 mx-auto mb-6" />
      <div className="space-y-4">
        <div className="h-10 bg-muted rounded" />
        <div className="h-10 bg-muted rounded" />
        <div className="h-12 bg-muted rounded" />
      </div>
      <div className="pt-4 text-center">
        <Link href="#" onClick={(e) => void handleLogout(e)} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <LogIn className="h-4 w-4" />
          {m['auth.federated_register.logout']()}
        </Link>
      </div>
    </div>
  );
}
