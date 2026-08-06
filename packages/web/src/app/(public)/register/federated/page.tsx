import { Suspense } from 'react';
import { FederatedRegisterForm } from './federated-register-form';
import { FederatedRegisterFormFallback } from './federated-register-form-fallback';

export const metadata = {
  title: '新規登録 | Crowi',
  description: 'Crowi に新規登録',
};

export default function FederatedRegisterPage() {
  return (
    <div className="bg-crowi-login min-h-screen flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo/500w-inverse.png" width={250} alt="Crowi" className="mx-auto mb-6" />
        </div>

        <Suspense fallback={<FederatedRegisterFormFallback />}>
          <FederatedRegisterForm />
        </Suspense>
      </div>
    </div>
  );
}
