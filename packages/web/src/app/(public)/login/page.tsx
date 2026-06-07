import { Suspense } from 'react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
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
    <div className="bg-crowi-login min-h-screen flex flex-col items-center justify-center p-4">
      <div className="fixed right-4 top-4 flex items-center gap-2">
        <ThemeToggle />
        <LocaleSwitcher />
      </div>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
        </div>

        <Suspense fallback={<LoginFormFallback />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
