import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ADMIN_SECTIONS, isAdminSectionKey } from '@/components/admin/admin-sections';

interface AdminSectionPageProps {
  params: Promise<{ section: string }>;
}

export default async function AdminSectionPage({ params }: AdminSectionPageProps) {
  const { section } = await params;
  if (!isAdminSectionKey(section)) {
    notFound();
  }

  const label = ADMIN_SECTIONS[section];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{label}</h1>
        <p className="text-muted-foreground mt-1 text-sm">この機能は開発中です。</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>{label} の管理画面は近日公開予定です。</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">この画面は管理画面の基盤移行の一環として用意されたプレースホルダです。実装は別タスクで順次行います。</p>
        </CardContent>
      </Card>
    </div>
  );
}
