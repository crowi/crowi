import { Suspense } from 'react';
import { ConfirmEmailForm } from './confirm-form';

export const metadata = {
  title: 'メールアドレスの確認 | Crowi',
  description: '新しいメールアドレスを確認',
};

export default function ConfirmEmailPage() {
  return (
    <div className="bg-crowi-login min-h-screen flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
        </div>
        <Suspense>
          <ConfirmEmailForm />
        </Suspense>
      </div>
    </div>
  );
}
