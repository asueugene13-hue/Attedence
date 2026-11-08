'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { NewPasswordForm } from '@/components/password-form';
import { Alert, BrandMark } from '@/components/ui';
import { apiFetch } from '@/lib/api';

function ActivateForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);

  return (
    <div className="card auth-card">
      <BrandMark />
      <div className="stack-sm">
        <h1>Activate your account</h1>
        <p className="secondary-text">Choose the password you will use to sign in to AttendSure.</p>
      </div>
      {done ? (
        <>
          <Alert tone="success">Your account is active. You can sign in now.</Alert>
          <Link className="btn btn-primary btn-block" href="/login">
            Go to sign in
          </Link>
        </>
      ) : token ? (
        <NewPasswordForm
          submitLabel="Activate account"
          onSubmit={async ({ password }) => {
            await apiFetch('/auth/activate', { method: 'POST', body: { token, password } });
            setDone(true);
          }}
        />
      ) : (
        <Alert tone="error">This activation link is incomplete. Open the link from your email again.</Alert>
      )}
    </div>
  );
}

export default function ActivatePage() {
  return (
    <main className="auth-page">
      <Suspense>
        <ActivateForm />
      </Suspense>
    </main>
  );
}
