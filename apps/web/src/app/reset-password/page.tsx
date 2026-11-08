'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { NewPasswordForm } from '@/components/password-form';
import { Alert, BrandMark } from '@/components/ui';
import { apiFetch } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);

  return (
    <div className="card auth-card">
      <BrandMark />
      <div className="stack-sm">
        <h1>Choose a new password</h1>
        <p className="secondary-text">
          You will be signed out everywhere, then you can sign in with the new password.
        </p>
      </div>
      {done ? (
        <>
          <Alert tone="success">Your password has been changed.</Alert>
          <Link className="btn btn-primary btn-block" href="/login">
            Go to sign in
          </Link>
        </>
      ) : token ? (
        <NewPasswordForm
          submitLabel="Change password"
          onSubmit={async ({ password }) => {
            await apiFetch('/auth/password/reset', { method: 'POST', body: { token, password } });
            setDone(true);
          }}
        />
      ) : (
        <Alert tone="error">This reset link is incomplete. Open the link from your email again.</Alert>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="auth-page">
      <Suspense>
        <ResetForm />
      </Suspense>
    </main>
  );
}
