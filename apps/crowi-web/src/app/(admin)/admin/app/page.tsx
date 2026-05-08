import { AppSettingsForm } from '@/components/admin/app-settings-form';
import { m } from '@/paraglide/messages.js';

/**
 * Dedicated route for the App settings screen. Sits next to the catch-all
 * `[section]` placeholder — Next.js routes static segments before dynamic ones,
 * so this file wins over `[section]/page.tsx` for `/admin/app` automatically.
 */
export default function AdminAppSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.app.heading']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.app.lead']()}</p>
      </div>

      <AppSettingsForm />
    </div>
  );
}
