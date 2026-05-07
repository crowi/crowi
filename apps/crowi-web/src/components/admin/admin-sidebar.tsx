'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, Database, Github, Globe, KeyRound, Link2, Mail, Search, Server, Settings, Share2, ShieldCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * 'available' for sections that have a working implementation; missing /
   * 'coming-soon' shows the placeholder copy on the admin dashboard. Sidebar
   * links are always clickable — the section page itself owns the empty UX.
   */
  status?: 'available' | 'coming-soon';
  /** One-line summary shown on the admin index card when status='available'. */
  description?: string;
}

interface AdminNavGroup {
  heading: string;
  items: AdminNavItem[];
}

const NAV_GROUPS: AdminNavGroup[] = [
  {
    heading: '設定',
    items: [
      { href: '/admin/app', label: 'アプリ設定', icon: Settings },
      {
        href: '/admin/security',
        label: 'セキュリティ',
        icon: ShieldCheck,
        status: 'available',
        description: 'Basic 認証 / 登録モード / ホワイトリスト',
      },
      { href: '/admin/auth', label: '認証', icon: KeyRound },
      { href: '/admin/mail', label: 'メール', icon: Mail },
      { href: '/admin/aws', label: 'AWS', icon: Server },
      { href: '/admin/google', label: 'Google OAuth', icon: Globe },
      { href: '/admin/github', label: 'GitHub OAuth', icon: Github },
      { href: '/admin/share', label: '共有設定', icon: Share2 },
    ],
  },
  {
    heading: 'ユーザー管理',
    items: [{ href: '/admin/users', label: 'ユーザー一覧', icon: Users }],
  },
  {
    heading: '通知',
    items: [{ href: '/admin/notification', label: '通知設定', icon: Bell }],
  },
  {
    heading: 'メンテナンス',
    items: [
      { href: '/admin/search', label: '検索インデックス', icon: Search },
      { href: '/admin/backlink', label: 'バックリンク', icon: Link2 },
    ],
  },
];

export const ADMIN_NAV_GROUPS = NAV_GROUPS;

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav className="space-y-6 text-sm" aria-label="Admin navigation">
      <div>
        <Link
          href="/admin"
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 font-medium transition-colors',
            pathname === '/admin' ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
          )}
        >
          <Database className="h-4 w-4" />
          管理ダッシュボード
        </Link>
      </div>
      {NAV_GROUPS.map((group) => (
        <div key={group.heading}>
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.heading}</p>
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
                    {item.label}
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
