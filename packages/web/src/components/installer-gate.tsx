'use client';

import { Loader2 } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { useInstallerStatus } from '@/lib/use-installer-status';

// Once an instance is installed it can never be uninstalled, so we cache
// that fact per-origin and skip the gate on every subsequent load. The cache
// is read through useSyncExternalStore so the server snapshot ("unknown")
// drives the hydration render and the client snapshot only takes over
// afterwards — preserving SSR ↔ hydration parity without setState-in-effect.
const INSTALLED_FLAG = 'crowi:installed';

const subscribeInstalledFlag = () => () => {};
const getInstalledFlag = () => localStorage.getItem(INSTALLED_FLAG) === '1';
const getInstalledFlagServer = () => false;

/**
 * Blocks the whole app until the install status is known and routes the
 * user to the right place:
 *
 *  - not installed → always send to `/installer` (and never reveal the
 *    login / register / wiki pages, which would otherwise look usable on a
 *    fresh instance — see the `crowi 未インストール` report).
 *  - installed but sitting on `/installer` → bounce to `/`.
 *
 * Crucially it renders a loading screen — not `children` — while the status
 * is still unknown or a redirect is pending, so no page flashes before the
 * redirect resolves.
 */
export function InstallerGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data } = useInstallerStatus();

  const knownInstalled = useSyncExternalStore(subscribeInstalledFlag, getInstalledFlag, getInstalledFlagServer);

  const onInstaller = pathname?.startsWith('/installer') ?? false;
  const installed = knownInstalled || data?.status === 'already_installed';

  // Persist the install flag the moment we learn the instance is installed
  // (from the live status query), so future loads skip straight to `children`.
  useEffect(() => {
    if (installed) {
      localStorage.setItem(INSTALLED_FLAG, '1');
    }
  }, [installed]);

  const redirectToInstaller = !installed && data?.status === 'installer_required' && !onInstaller;
  const redirectToHome = installed && onInstaller;

  useEffect(() => {
    if (redirectToInstaller) {
      router.replace('/installer');
    } else if (redirectToHome) {
      router.replace('/');
    }
  }, [redirectToInstaller, redirectToHome, router]);

  // Hold back `children` whenever we shouldn't reveal a page yet:
  //  - off `/installer` and not (yet) known-installed → status unknown or
  //    needs-install; either way show loading until it resolves / redirects.
  //  - on `/installer` but already installed → redirecting to `/`.
  // The `/installer` page itself renders immediately on a not-installed
  // instance (neither branch matches).
  const holdForRedirect = (!onInstaller && !installed) || redirectToHome;
  if (holdForRedirect) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" role="status">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return <>{children}</>;
}
