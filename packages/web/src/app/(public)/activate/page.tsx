import { Suspense } from 'react';
import { ActivateForm } from './activate-form';

export const metadata = {
  title: 'アカウントの有効化 | Crowi',
  description: 'メールアドレスを確認してアカウントを有効化',
};

export default function ActivatePage() {
  return (
    <div className="bg-crowi-login min-h-screen flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
        </div>
        <Suspense>
          <ActivateForm />
        </Suspense>
      </div>
    </div>
  );
}
