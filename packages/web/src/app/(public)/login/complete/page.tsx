import { Suspense } from 'react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { LoginCompleteForm } from './login-complete-form';

export const metadata = {
  title: 'サインイン | Crowi',
  description: 'Crowi にサインイン',
};

export default function LoginCompletePage() {
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

        {/* `useSearchParams` in the client component below requires a
            Suspense boundary — the `code` only exists at request time. */}
        <Suspense fallback={<div className="bg-card rounded-lg shadow-2xl p-6 h-32 animate-pulse" />}>
          <LoginCompleteForm />
        </Suspense>
      </div>
    </div>
  );
}
