import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ADMIN_SECTIONS, isAdminSectionKey } from '@/components/admin/admin-sections';
import { m } from '@paraglide/messages.js';

interface AdminSectionPageProps {
  params: Promise<{ section: string }>;
}

export default async function AdminSectionPage({ params }: AdminSectionPageProps) {
  const { section } = await params;
  if (!isAdminSectionKey(section)) {
    notFound();
  }

  const label = ADMIN_SECTIONS[section]();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{label}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.coming_soon_body']()}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.coming_soon']()}</CardTitle>
          <CardDescription>{label}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{m['admin.coming_soon_body']()}</p>
        </CardContent>
      </Card>
    </div>
  );
}
