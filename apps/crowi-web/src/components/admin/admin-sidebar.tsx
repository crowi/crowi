'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, Database, Github, Globe, KeyRound, Link2, Mail, Search, Server, Settings, Share2, ShieldCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';

interface AdminNavItem {
  href: string;
  label: () => string;
  icon: LucideIcon;
  /**
   * 'available' for sections that have a working implementation; missing /
   * 'coming-soon' shows the placeholder copy on the admin dashboard. Sidebar
   * links are always clickable — the section page itself owns the empty UX.
   */
  status?: 'available' | 'coming-soon';
  /** One-line summary shown on the admin index card when status='available'. */
  description?: () => string;
}

interface AdminNavGroup {
  heading: () => string;
  items: AdminNavItem[];
}

const NAV_GROUPS: AdminNavGroup[] = [
  {
    heading: () => m['admin.section_settings'](),
    items: [
      { href: '/admin/app', label: () => m['admin.nav_app'](), icon: Settings },
      {
        href: '/admin/security',
        label: () => m['admin.nav_security'](),
        icon: ShieldCheck,
        status: 'available',
        description: () => m['admin.nav_security_summary'](),
      },
      { href: '/admin/auth', label: () => m['admin.nav_auth'](), icon: KeyRound },
      { href: '/admin/mail', label: () => m['admin.nav_mail'](), icon: Mail },
      { href: '/admin/aws', label: () => m['admin.nav_aws'](), icon: Server },
      { href: '/admin/google', label: () => m['admin.nav_google'](), icon: Globe },
      { href: '/admin/github', label: () => m['admin.nav_github'](), icon: Github },
      { href: '/admin/share', label: () => m['admin.nav_share'](), icon: Share2 },
    ],
  },
  {
    heading: () => m['admin.section_users'](),
    items: [{ href: '/admin/users', label: () => m['admin.nav_users'](), icon: Users }],
  },
  {
    heading: () => m['admin.section_notification'](),
    items: [{ href: '/admin/notification', label: () => m['admin.nav_notification'](), icon: Bell }],
  },
  {
    heading: () => m['admin.section_maintenance'](),
    items: [
      { href: '/admin/search', label: () => m['admin.nav_search'](), icon: Search },
      { href: '/admin/backlink', label: () => m['admin.nav_backlink'](), icon: Link2 },
    ],
  },
];

export const ADMIN_NAV_GROUPS = NAV_GROUPS;

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav className="space-y-6 text-sm" aria-label={m['admin.nav_dashboard']()}>
      <div>
        <Link
          href="/admin"
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 font-medium transition-colors',
            pathname === '/admin' ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
          )}
        >
          <Database className="h-4 w-4" />
          {m['admin.nav_dashboard']()}
        </Link>
      </div>
      {NAV_GROUPS.map((group) => (
        <div key={group.heading()}>
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.heading()}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-2 transition-colors',
                      isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label()}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
