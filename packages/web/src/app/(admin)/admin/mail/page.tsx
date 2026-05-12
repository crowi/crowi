import { MailSettingsForm } from '@/components/admin/mail-settings-form';
import { m } from '@paraglide/messages.js';

export default function AdminMailSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.mail.heading']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.mail.lead']()}</p>
      </div>

      <MailSettingsForm />
    </div>
  );
}
