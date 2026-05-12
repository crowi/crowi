'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useInstallerStatus } from '@/lib/use-installer-status';

export function InstallerGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data } = useInstallerStatus();

  useEffect(() => {
    if (!data) return;
    const onInstaller = pathname?.startsWith('/installer') ?? false;
    if (data.status === 'already_installed' && onInstaller) {
      router.replace('/');
    } else if (data.status !== 'already_installed' && !onInstaller) {
      router.replace('/installer');
    }
  }, [data, pathname, router]);

  return <>{children}</>;
}
