'use client';

import { Bell, Home, type LucideIcon, Shield, User, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { m } from '@paraglide/messages.js';
import { useAuth } from '@/lib/use-auth';
import { cn } from '@/lib/utils';

function NavLink({ href, icon: Icon, label, active }: { href: string; icon: LucideIcon; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  );
}

/**
 * Shared top section of the page sidebar: top / my page / members /
 * notifications, plus an admin shortcut for administrators. Mirrors the
 * destinations also reachable from the header user dropdown.
 */
export function SidebarNavLinks() {
  const pathname = usePathname();
  const { user } = useAuth();
  const username = user?.username;

  return (
    <nav className="space-y-0.5" aria-label="Primary">
      <NavLink href="/" icon={Home} label={m['sidebar.nav_top']()} active={pathname === '/'} />
      {username && <NavLink href={`/user/${username}`} icon={User} label={m['sidebar.nav_my_page']()} active={pathname === `/user/${username}`} />}
      <NavLink href="/_user" icon={Users} label={m['sidebar.nav_users']()} active={pathname === '/_user'} />
      <NavLink href="/_notifications" icon={Bell} label={m['sidebar.nav_notifications']()} active={pathname === '/_notifications'} />
      {user?.admin === true && (
        <>
          <div className="my-1.5 border-t border-border/60" aria-hidden />
          <NavLink href="/admin" icon={Shield} label={m['sidebar.nav_admin']()} active={pathname?.startsWith('/admin') ?? false} />
        </>
      )}
    </nav>
  );
}
