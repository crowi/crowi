import { m } from '@paraglide/messages.js';

/**
 * Admin section metadata used by the sidebar, breadcrumb, and dynamic
 * `[section]` placeholder pages. The keys are the URL slug (after `/admin/`)
 * and values are getters that return the localised display label so the
 * runtime locale (cookie) drives the rendered text.
 */
export const ADMIN_SECTIONS = {
  app: () => m['admin.nav_app'](),
  security: () => m['admin.nav_security'](),
  auth: () => m['admin.nav_auth'](),
  mail: () => m['admin.nav_mail'](),
  aws: () => m['admin.nav_aws'](),
  google: () => m['admin.nav_google'](),
  github: () => m['admin.nav_github'](),
  share: () => m['admin.nav_share'](),
  users: () => m['admin.nav_users'](),
  notification: () => m['admin.nav_notification'](),
  search: () => m['admin.nav_search'](),
  backlink: () => m['admin.nav_backlink'](),
} as const;

export type AdminSectionKey = keyof typeof ADMIN_SECTIONS;

export function isAdminSectionKey(value: string): value is AdminSectionKey {
  return Object.prototype.hasOwnProperty.call(ADMIN_SECTIONS, value);
}
