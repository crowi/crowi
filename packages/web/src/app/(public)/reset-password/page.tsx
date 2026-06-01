import { Suspense } from 'react';
import { ResetPasswordForm } from './reset-form';

export const metadata = {
  title: 'パスワードの再設定 | Crowi',
  description: '新しいパスワードを設定',
};

function ResetPasswordFormFallback() {
  return (
    <div className="bg-card rounded-lg shadow-2xl p-6 animate-pulse">
      <div className="h-6 bg-muted rounded w-1/3 mx-auto mb-6" />
      <div className="space-y-4">
        <div className="h-10 bg-muted rounded" />
        <div className="h-12 bg-muted rounded" />
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="bg-crowi-login min-h-screen flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
        </div>
        <Suspense fallback={<ResetPasswordFormFallback />}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
