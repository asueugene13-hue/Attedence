'use client';

import { useState } from 'react';
import { NewPasswordForm } from '@/components/password-form';
import { Alert, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function ChangePasswordPage() {
  const auth = useAuth();
  const [done, setDone] = useState(false);

  return (
    <div className="stack" style={{ maxWidth: 480 }}>
      <PageHeader
        title="Change password"
        subtitle="Your other devices will be signed out. This one stays signed in."
      />
      {done ? (
        <Alert tone="success">Your password has been changed.</Alert>
      ) : (
        <div className="card card-body">
          <NewPasswordForm
            currentPassword
            submitLabel="Change password"
            onSubmit={async ({ password, currentPassword }) => {
              await auth.call('/auth/password/change', {
                method: 'POST',
                body: { currentPassword, newPassword: password },
              });
              setDone(true);
            }}
          />
        </div>
      )}
    </div>
  );
}
