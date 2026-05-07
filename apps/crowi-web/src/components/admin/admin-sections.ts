/**
 * Admin section metadata used by the sidebar, breadcrumb, and dynamic
 * `[section]` placeholder pages. The keys are the URL slug (after `/admin/`)
 * and values are the Japanese display labels.
 */
export const ADMIN_SECTIONS = {
  app: 'アプリ設定',
  security: 'セキュリティ',
  auth: '認証',
  mail: 'メール',
  aws: 'AWS',
  google: 'Google OAuth',
  github: 'GitHub OAuth',
  share: '共有設定',
  users: 'ユーザー一覧',
  notification: '通知設定',
  search: '検索インデックス',
  backlink: 'バックリンク',
} as const;

export type AdminSectionKey = keyof typeof ADMIN_SECTIONS;

export function isAdminSectionKey(value: string): value is AdminSectionKey {
  return Object.prototype.hasOwnProperty.call(ADMIN_SECTIONS, value);
}
