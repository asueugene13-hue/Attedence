'use client';

import { STAFF_ADMIN_ROLES, type StaffAdminRole } from '@attendsure/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { Alert, Button, Field, PageHeader } from '@/components/ui';
import { ApiError, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { roleLabel } from '@/lib/format';
import type { UserDetail } from '@/lib/types';

export default function NewUserPage() {
  return (
    <PermissionGate permission="users.manage_admins">
      <NewUserForm />
    </PermissionGate>
  );
}

function NewUserForm() {
  const auth = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [roles, setRoles] = useState<StaffAdminRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const toggle = (role: StaffAdminRole) =>
    setRoles((current) => (current.includes(role) ? current.filter((r) => r !== role) : [...current, role]));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    if (roles.length === 0) {
      setFieldErrors({ roles: 'Choose at least one role.' });
      return;
    }
    setBusy(true);
    try {
      const result = await auth.call<{ user: UserDetail; activationEmailSent: boolean }>('/users', {
        method: 'POST',
        body: { fullName, email, ...(phone.trim() ? { phone } : {}), roles: roles.map((role) => ({ role })) },
      });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      router.push(`/admin/users/${result.user.id}?created=${result.activationEmailSent ? 'sent' : 'unsent'}`);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.length > 0) {
        setFieldErrors(
          Object.fromEntries(err.fieldErrors.map((e) => [e.field?.split('.')[0] ?? 'form', e.message])),
        );
      }
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <PageHeader
        title="New staff account"
        subtitle="The person receives an email to choose their password. Staff roles also set up two-step sign-in."
      />
      <form className="card card-body stack" onSubmit={submit} noValidate>
        <Field
          label="Full name"
          name="fullName"
          required
          value={fullName}
          onChange={setFullName}
          error={fieldErrors.fullName}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          required
          value={email}
          onChange={setEmail}
          error={fieldErrors.email}
        />
        <Field
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={setPhone}
          hint="Optional. A Ghana number, e.g. 024 555 0123"
          error={fieldErrors.phone}
        />
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ marginBottom: 8 }}>
            Roles *
          </legend>
          {STAFF_ADMIN_ROLES.map((role) => (
            <label key={role} className="checkbox">
              <input type="checkbox" checked={roles.includes(role)} onChange={() => toggle(role)} />
              {roleLabel(role)}
            </label>
          ))}
          {fieldErrors.roles ? <span className="field-error">{fieldErrors.roles}</span> : null}
        </fieldset>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="row">
          <Button type="button" variant="secondary" onClick={() => router.push('/admin/users')}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} busyLabel="Creating…">
            Create account
          </Button>
        </div>
      </form>
    </div>
  );
}
