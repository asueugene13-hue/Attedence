'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, BrandMark, Button, Field } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const auth = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === 'signed-in') router.replace('/');
  }, [auth.status, router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await auth.login(email, password);
      if ('mfaRequired' in result) {
        auth.setPendingMfa(result);
        router.push('/login/two-step');
      } else {
        await auth.completeSession(result);
        router.replace('/');
      }
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
          <h1>Sign in</h1>
          <p className="secondary-text">Use the email address the university registered for you.</p>
        </div>
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
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={setPassword}
          />
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" block busy={busy} busyLabel="Signing in…">
            Sign in
          </Button>
        </form>
        <Link href="/forgot-password">Forgot your password?</Link>
      </div>
    </main>
  );
}
