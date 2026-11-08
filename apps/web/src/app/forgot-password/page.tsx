'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, BrandMark, Button, Field } from '@/components/ui';
import { apiFetch, describeError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ message: string }>('/auth/password/forgot', {
        method: 'POST',
        body: { email },
      });
      setSentMessage(result.message);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="card auth-card">
        <BrandMark />
        <div className="stack-sm">
          <h1>Reset your password</h1>
          <p className="secondary-text">We will email you a link to choose a new password.</p>
        </div>
        {sentMessage ? (
          <Alert tone="success">{sentMessage}</Alert>
        ) : (
          <form className="stack" onSubmit={submit}>
            <Field
              label="Email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={setEmail}
              autoFocus
            />
            {error ? <Alert tone="error">{error}</Alert> : null}
            <Button type="submit" block busy={busy}>
              Send reset link
            </Button>
          </form>
        )}
        <Link href="/login">Back to sign in</Link>
      </div>
    </main>
  );
}
