'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Bell, Cloud, Database, HardDrive, Key, KeyRound, Mail, Plug, Search, Server, Settings, Share2, ShieldCheck, UserCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PluginInfo } from '@crowi/api-contract';
import { GoogleMark, SlackMark } from '@/components/brand-icons';
import { cn } from '@/lib/utils';
import { useAdminPlugins } from '@/lib/use-admin-plugins';
import { useAdminPendingUsersCount } from '@/lib/use-admin-users';
import { m } from '@paraglide/messages.js';

/**
 * Anything renderable as `<Icon className="h-4 w-4" />`. Wider than
 * `LucideIcon` so a vendor brand mark (see `components/brand-icons.tsx`)
 * can sit in the same slot — lucide has no Google logo, and its `Chrome`
 * icon names a different product.
 */
type BrandOrLucideIcon = LucideIcon | ((props: { className?: string }) => React.JSX.Element);

interface AdminNavItem {
  href: string;
  label: () => string;
  icon: BrandOrLucideIcon;
  /** One-line summary shown on the admin index card. */
  description?: () => string;
  /**
   * Stable id used to deduplicate items when plugin-injected entries
   * collide with static ones. For static entries this matches `href`;
   * for plugin entries it's the plugin npm name.
   */
  key?: string;
  /**
   * Optional count badge (e.g. pending user-approval count). Rendered only
   * when > 0; injected at render time, not part of the static config.
   */
  badge?: number;
}

/**
 * Section identifier for the groups this sidebar actually renders.
 *
 * Deliberately NOT the same set as `adminPlacement.section` on the
 * plugin-api contract: that enum also allows `'auth'` and
 * `'notification'`, which have no heading here. A plugin may therefore
 * name a section this sidebar does not implement — `injectPluginEntries`
 * places those under `'settings'` rather than dropping them, so a
 * mismatch can never make a plugin's config page unreachable.
 */
type SectionKey = 'settings' | 'users' | 'storage' | 'mail' | 'search' | 'renderer' | 'shared' | 'platform';

/** Where an entry goes when its declared section has no group — matches the api's own `resolvePlacement` default. */
const FALLBACK_SECTION: SectionKey = 'settings';

interface AdminNavGroup {
  key: SectionKey;
  heading: () => string;
  items: AdminNavItem[];
  /** When true, the section is hidden entirely if `items` is empty. */
  hideWhenEmpty?: boolean;
}

const STATIC_GROUPS: AdminNavGroup[] = [
  {
    key: 'settings',
    heading: () => m['admin.section_settings'](),
    items: [
      {
        href: '/admin/app',
        label: () => m['admin.nav_app'](),
        icon: Settings,
        description: () => m['admin.nav_app_summary'](),
      },
      {
        href: '/admin/security',
        label: () => m['admin.nav_security'](),
        icon: ShieldCheck,
        description: () => m['admin.nav_security_summary'](),
      },
      {
        href: '/admin/auth',
        label: () => m['admin.nav_auth'](),
        icon: KeyRound,
        description: () => m['admin.nav_auth_summary'](),
      },
      {
        href: '/admin/plugins',
        label: () => m['admin.nav_plugins'](),
        icon: Plug,
        description: () => m['admin.nav_plugins_summary'](),
      },
    ],
  },
  {
    key: 'users',
    heading: () => m['admin.section_users'](),
    items: [
      {
        href: '/admin/users',
        label: () => m['admin.nav_users'](),
        icon: Users,
        description: () => m['admin.users.lead'](),
      },
    ],
  },
  {
    key: 'shared',
    heading: () => m['admin.section_shared'](),
    items: [],
    hideWhenEmpty: true,
  },
  {
    key: 'storage',
    heading: () => m['admin.section_storage'](),
    // Static entry first, then storage-driver plugins inject under this
    // heading via `injectPluginEntries` (so each driver's settings page
    // is one click away). Always visible — the status page is useful
    // even on a fresh install with only the implicit-default plugins.
    items: [
      {
        href: '/admin/storage',
        label: () => m['admin.nav_storage'](),
        icon: HardDrive,
        description: () => m['admin.nav_storage_summary'](),
      },
    ],
  },
  {
    key: 'mail',
    heading: () => m['admin.section_mail'](),
    items: [{ href: '/admin/mail', label: () => m['admin.nav_mail'](), icon: Mail }],
  },
  {
    key: 'search',
    // Static "search index" status/rebuild page first; search-backend
    // plugins (e.g. Elasticsearch, derived via `registerSearch`) inject
    // their settings page under this heading.
    heading: () => m['admin.section_search'](),
    items: [{ href: '/admin/search', label: () => m['admin.nav_search'](), icon: Search }],
  },
  {
    // External platform / service integrations (Slack, …) inject here via
    // the `'platform'` section. Hidden until a platform plugin exposes
    // config.
    key: 'platform',
    heading: () => m['admin.section_platform'](),
    items: [],
    hideWhenEmpty: true,
  },
  {
    // Renderer plugins (PlantUML, KaTeX, …) inject here via the
    // `registerRenderer`-derived `'renderer'` section. Hidden when no
    // renderer plugin exposes config.
    key: 'renderer',
    heading: () => m['admin.section_renderer'](),
    items: [],
    hideWhenEmpty: true,
  },
];

/**
 * Allow-list of lucide-react icons a plugin can declare via
 * `adminPlacement.icon`. Keeps the bundle tight and discourages
 * plugins from picking obscure icons we don't render anywhere else.
 */
const PLUGIN_ICON_BY_NAME: Record<string, BrandOrLucideIcon> = {
  cloud: Cloud,
  'hard-drive': HardDrive,
  server: Server,
  database: Database,
  bell: Bell,
  mail: Mail,
  key: Key,
  'key-round': KeyRound,
  share: Share2,
  search: Search,
  // Vendor marks. `slack` is the branded four-colour logo rather than
  // lucide's monochrome `Slack`, so the two integrations that have a
  // real logo look the same as each other.
  google: GoogleMark,
  slack: SlackMark,
};

const DEFAULT_PLUGIN_ICON: BrandOrLucideIcon = Plug;

/**
 * Static section list, exported for the admin index page that
 * mirrors the same heading order. Plugin-injected items are computed
 * inside `<AdminSidebar>` at render time and not part of the
 * exported static list.
 */
export const ADMIN_NAV_GROUPS = STATIC_GROUPS;

export function AdminSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const editPluginName = searchParams?.get('name');

  const { data } = useAdminPlugins();
  const { data: pending } = useAdminPendingUsersCount();
  const plugins = data?.plugins;
  const pendingCount = pending?.count ?? 0;
  const groups = useMemo(() => injectApprovalEntry(injectPluginEntries(STATIC_GROUPS, plugins ?? []), pendingCount), [plugins, pendingCount]);

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
      {groups.map((group) => {
        if (group.hideWhenEmpty && group.items.length === 0) return null;
        return (
          <div key={group.key}>
            <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.heading()}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = isSidebarActive(item, pathname, editPluginName);
                const Icon = item.icon;
                return (
                  <li key={item.key ?? item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-2 transition-colors',
                        isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="truncate">{item.label()}</span>
                      {item.badge !== undefined && item.badge > 0 && (
                        <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Build the runtime sidebar by merging static groups with one entry
 * per loaded plugin. Each plugin lands in the section identified by
 * `adminPlacement.section`. Plugins without `hasConfig` are skipped
 * (no config form to navigate to).
 */
function injectPluginEntries(staticGroups: AdminNavGroup[], plugins: PluginInfo[]): AdminNavGroup[] {
  const groupsByKey = new Map<SectionKey, AdminNavGroup>(staticGroups.map((g) => [g.key, { ...g, items: [...g.items] }]));

  for (const plugin of plugins) {
    if (!plugin.hasConfig) continue;
    const sectionKey = plugin.adminPlacement.section as SectionKey;
    // Fall back rather than `continue`: a plugin naming a section this
    // sidebar has no heading for (the contract allows `'auth'` and
    // `'notification'`, neither of which is a group here) used to vanish
    // silently, leaving its config page reachable only by typing the URL.
    const group = groupsByKey.get(sectionKey) ?? groupsByKey.get(FALLBACK_SECTION);
    if (!group) continue;
    group.items.push({
      key: plugin.name,
      href: `/admin/plugins/edit?name=${encodeURIComponent(plugin.name)}`,
      label: () => plugin.adminPlacement.label,
      icon: pluginIcon(plugin.adminPlacement.icon),
    });
  }

  // Preserve the original static-group order.
  return staticGroups.map((g) => groupsByKey.get(g.key) ?? g);
}

/**
 * Surface a "user approval" entry under the users group when one or more
 * sign-ups await admin approval (status REGISTERED). Hidden at zero so the
 * sidebar stays quiet on installs that never use restricted registration.
 * The count rides along as a badge so admins notice without opening the page.
 */
function injectApprovalEntry(groups: AdminNavGroup[], pendingCount: number): AdminNavGroup[] {
  if (pendingCount <= 0) return groups;
  return groups.map((group) => {
    if (group.key !== 'users') return group;
    return {
      ...group,
      items: [
        ...group.items,
        {
          key: '/admin/users/pending',
          href: '/admin/users/pending',
          label: () => m['admin.nav_users_pending'](),
          icon: UserCheck,
          badge: pendingCount,
        },
      ],
    };
  });
}

function pluginIcon(name: string | undefined): BrandOrLucideIcon {
  if (!name) return DEFAULT_PLUGIN_ICON;
  return PLUGIN_ICON_BY_NAME[name] ?? DEFAULT_PLUGIN_ICON;
}

/**
 * Plugin-edit links share the same `/admin/plugins/edit` pathname,
 * so we have to match on the `?name=` query string to highlight the
 * right entry while editing.
 */
function isSidebarActive(item: AdminNavItem, pathname: string | null, editPluginName: string | null): boolean {
  if (!pathname) return false;
  if (item.href === pathname) return true;
  if (pathname === '/admin/plugins/edit' && editPluginName && item.key === editPluginName) return true;
  return false;
}
