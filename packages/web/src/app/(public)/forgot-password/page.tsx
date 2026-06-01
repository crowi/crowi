import { Suspense } from 'react';
import { ForgotPasswordForm } from './forgot-form';

export const metadata = {
  title: 'パスワードをお忘れですか? | Crowi',
  description: 'パスワード再設定リンクをメールで受け取る',
};

export default function ForgotPasswordPage() {
  return (
    <div className="bg-crowi-login min-h-screen flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
        </div>
        <Suspense>
          <ForgotPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
