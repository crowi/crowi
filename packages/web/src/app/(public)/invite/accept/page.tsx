import { Suspense } from 'react';
import { AcceptInviteForm } from './accept-form';

export const metadata = {
  title: '招待を受ける | Crowi',
  description: 'Crowi への招待を受けてアカウントを設定',
};

function AcceptInviteFormFallback() {
  return (
    <div className="bg-card rounded-lg shadow-2xl p-6 animate-pulse">
      <div className="h-6 bg-muted rounded w-1/3 mx-auto mb-6" />
      <div className="space-y-4">
        <div className="h-10 bg-muted rounded" />
        <div className="h-10 bg-muted rounded" />
        <div className="h-10 bg-muted rounded" />
        <div className="h-12 bg-muted rounded" />
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="bg-crowi-login min-h-screen flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
        </div>

        <Suspense fallback={<AcceptInviteFormFallback />}>
          <AcceptInviteForm />
        </Suspense>
      </div>
    </div>
  );
}
