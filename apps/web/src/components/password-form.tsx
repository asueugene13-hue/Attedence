'use client';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@attendsure/shared';
import { useState } from 'react';
import { ApiError, describeError } from '@/lib/api';
import { Alert, Button, Field } from './ui';

/** Choose-a-password form used by activation, reset and change-password pages. */
export function NewPasswordForm(props: {
  submitLabel: string;
  currentPassword?: boolean;
  onSubmit: (input: { password: string; currentPassword?: string }) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldError(null);
    if (password.length < PASSWORD_MIN_LENGTH) {
      setFieldError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setFieldError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await props.onSubmit({ password, currentPassword: props.currentPassword ? current : undefined });
    } catch (err) {
      const fromServer =
        err instanceof ApiError
          ? err.fieldErrors.find((e) => e.field === 'password' || e.field === 'newPassword')
          : undefined;
      if (fromServer) setFieldError(`Password ${fromServer.message}.`);
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {props.currentPassword ? (
        <Field
          label="Current password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={setCurrent}
        />
      ) : null}
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        value={password}
        onChange={setPassword}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong, memorable password.`}
        error={fieldError ?? undefined}
      />
      <Field
        label="Repeat new password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        value={confirm}
        onChange={setConfirm}
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button type="submit" block busy={busy}>
        {props.submitLabel}
      </Button>
    </form>
  );
}
