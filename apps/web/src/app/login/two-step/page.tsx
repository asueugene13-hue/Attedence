'use client';

import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Alert, BrandMark, Button, Field, LoadingState } from '@/components/ui';
import { apiFetch, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SessionResponse } from '@/lib/types';

interface Enrollment {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export default function TwoStepPage() {
  const auth = useAuth();
  const router = useRouter();
  const challenge = auth.pendingMfa;
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ codes: string[]; session: SessionResponse } | null>(null);
  const [saved, setSaved] = useState(false);

  // The challenge lives in memory only; after a page reload the person starts again at the password step.
  useEffect(() => {
    if (!challenge && !recovery) router.replace('/login');
  }, [challenge, recovery, router]);

  useEffect(() => {
    if (!challenge?.enrollmentRequired || enrollment) return;
    apiFetch<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll', {
      method: 'POST',
      body: { mfaToken: challenge.mfaToken },
    })
      .then(async (result) =>
        setEnrollment({
          ...result,
          qrDataUrl: await QRCode.toDataURL(result.otpauthUri, { margin: 1, width: 200 }),
        }),
      )
      .catch((err: unknown) => setError(describeError(err)));
  }, [challenge, enrollment]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const body = useRecovery
        ? { mfaToken: challenge.mfaToken, recoveryCode: code.trim() }
        : { mfaToken: challenge.mfaToken, code: code.trim() };
      const session = await apiFetch<SessionResponse>('/auth/mfa/verify', { method: 'POST', body });
      if (session.recoveryCodes) {
        setRecovery({ codes: session.recoveryCodes, session });
        auth.setPendingMfa(null);
      } else {
        await auth.completeSession(session);
        router.replace('/');
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!recovery) return;
    await auth.completeSession(recovery.session);
    router.replace('/');
  }

  if (recovery) {
    return (
      <main className="auth-page">
        <div className="card auth-card">
          <BrandMark />
          <div className="stack-sm">
            <h1>Save your recovery codes</h1>
            <p className="secondary-text">
              If you lose your phone, each code lets you sign in once. They are shown only now. Keep them
              somewhere safe and private, such as a password manager or a printed copy in a locked drawer.
            </p>
          </div>
          <ul className="recovery-codes" aria-label="Recovery codes">
            {recovery.codes.map((c) => (
              <li key={c} className="code-block">
                {c}
              </li>
            ))}
          </ul>
          <label className="checkbox">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved
            these codes somewhere safe.
          </label>
          <Button block disabled={!saved} onClick={finish}>
            Continue to AttendSure
          </Button>
        </div>
      </main>
    );
  }

  if (!challenge) return null;
  const enrolling = challenge.enrollmentRequired;
  const intro = enrolling
    ? 'Your role can change records for many people, so signing in needs a code from an authenticator app (for example Google Authenticator or Microsoft Authenticator) as well as your password.'
    : useRecovery
      ? 'Enter one of the recovery codes you saved when you set up two-step sign-in.'
      : 'Enter the 6-digit code from your authenticator app.';

  return (
    <main className="auth-page">
      <div className="card auth-card">
        <BrandMark />
        <div className="stack-sm">
          <h1>{enrolling ? 'Set up two-step sign-in' : 'Two-step sign-in'}</h1>
          <p className="secondary-text">{intro}</p>
        </div>

        {enrolling && enrollment ? (
          <div className="stack">
            <ol className="stack-sm secondary-text" style={{ margin: 0, paddingLeft: 20 }}>
              <li>Open your authenticator app and add an account.</li>
              <li>Scan this code, or type the setup key below.</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            {/* A generated data URL, not a remote image, so next/image is not needed. */}
            <img
              className="qr"
              src={enrollment.qrDataUrl}
              width={200}
              height={200}
              alt="QR code that adds AttendSure to your authenticator app"
            />
            <div className="stack-sm">
              <span className="field-label">Setup key (if you cannot scan)</span>
              <code className="code-block" data-testid="mfa-secret">
                {enrollment.secret}
              </code>
            </div>
          </div>
        ) : null}
        {enrolling && !enrollment && !error ? <LoadingState label="Preparing your setup code…" /> : null}

        <form className="stack" onSubmit={submit}>
          <Field
            label={useRecovery ? 'Recovery code' : '6-digit code'}
            name="code"
            autoComplete="one-time-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            maxLength={useRecovery ? 11 : 6}
            required
            value={code}
            onChange={setCode}
            autoFocus
          />
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" block busy={busy} busyLabel="Checking…" disabled={enrolling && !enrollment}>
            {enrolling ? 'Turn on two-step sign-in' : 'Sign in'}
          </Button>
        </form>
        {!enrolling ? (
          <Button
            variant="ghost"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode('');
              setError(null);
            }}
          >
            {useRecovery ? 'Use a code from my app instead' : 'Lost your phone? Use a recovery code'}
          </Button>
        ) : null}
      </div>
    </main>
  );
}
