import { LoginForm } from './login-form';

export const metadata = {
  title: 'サインイン | Crowi',
  description: 'Crowi にサインイン',
};

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

        <LoginForm />
      </div>
    </div>
  );
}
