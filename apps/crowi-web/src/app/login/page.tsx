import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const metadata = {
  title: 'サインイン | Crowi',
  description: 'Crowi にサインイン',
};

function LoginFormFallback() {
  return (
    <div className="bg-card rounded-lg shadow-2xl p-6 animate-pulse">
      <div className="h-6 bg-muted rounded w-1/3 mx-auto mb-6" />
      <div className="space-y-4">
        <div className="h-10 bg-muted rounded" />
        <div className="h-10 bg-muted rounded" />
        <div className="h-12 bg-muted rounded" />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)] p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/logo/500w-inverse.png"
            width={250}
            alt="Crowi"
            className="mx-auto mb-6"
          />
        </div>

        <Suspense fallback={<LoginFormFallback />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
