import { AppSettingsForm } from '@/components/admin/app-settings-form';
import { ADMIN_SECTIONS } from '@/components/admin/admin-sections';

/**
 * Dedicated route for the App settings screen. Sits next to the catch-all
 * `[section]` placeholder — Next.js routes static segments before dynamic ones,
 * so this file wins over `[section]/page.tsx` for `/admin/app` automatically.
 */
export default function AdminAppSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{ADMIN_SECTIONS.app}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          サイト名 / 機密情報の注意書き / ファイルアップロード / AWS S3 の認証情報を管理します。secretAccessKey は暗号化されて保存されます。
        </p>
      </div>

      <AppSettingsForm />
    </div>
  );
}
