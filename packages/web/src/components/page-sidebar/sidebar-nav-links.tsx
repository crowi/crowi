'use client';

import { m } from '@paraglide/messages.js';
import { Bell, Home, type LucideIcon, Shield, User, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MouseEventHandler, ReactNode } from 'react';
import { ReloadHint } from '@/components/reload-hint';
import { useAuth } from '@/lib/use-auth';
import { useReloadOnCurrentRoute } from '@/lib/use-reload-on-current-route';
import { cn } from '@/lib/utils';

function NavLink({
  href,
  icon: Icon,
  label,
  active,
  onClick,
  children,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  children?: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
      {children}
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
  const top = useReloadOnCurrentRoute('/');

  return (
    <nav className="space-y-0.5" aria-label="Primary">
      <NavLink href="/" icon={Home} label={m['sidebar.nav_top']()} active={top.isCurrent} onClick={top.onClick}>
        {top.isCurrent && <ReloadHint className="ml-auto" />}
      </NavLink>
      {username && <NavLink href={`/user/${username}`} icon={User} label={m['sidebar.nav_my_page']()} active={pathname === `/user/${username}`} />}
      {/* Link to the hierarchical member directory `/user/` (the preview +
          "show all" into the full `/_user` roster), not the special `/_user`
          route directly, so the path matches the rest of the wiki scheme. */}
      <NavLink href="/user/" icon={Users} label={m['sidebar.nav_users']()} active={pathname === '/user/' || pathname === '/user'} />
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
