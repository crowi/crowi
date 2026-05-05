import { InstallerForm } from './installer-form';

export const metadata = {
  title: 'セットアップ | Crowi',
  description: 'Crowi の初期セットアップ',
};

export default function InstallerPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-[var(--crowi-header)] via-[oklch(0.35_0.03_192)] to-[oklch(0.4_0.04_170)] p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
          <h1 className="text-2xl font-semibold text-white drop-shadow-md">セットアップへようこそ!</h1>
        </div>

        <InstallerForm />
      </div>
    </div>
  );
}
