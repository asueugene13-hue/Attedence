'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { PermissionGate } from '@/components/permission-gate';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface Setting {
  key: string;
  label: string;
  description: string;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  version: number;
  updatedAt: string | null;
  updatedBy: { fullName: string } | null;
}

export default function SettingsPage() {
  return (
    <PermissionGate permission="settings.manage">
      <Settings />
    </PermissionGate>
  );
}

/** University settings, starting with the class-monitoring timings and thresholds (D-13). */
function Settings() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => auth.call<Setting[]>('/settings') });
  const [editing, setEditing] = useState<Setting | null>(null);

  return (
    <div className="stack">
      <PageHeader
        title="Settings"
        subtitle="Values the system uses to monitor classes. Every change needs a reason and is recorded in the audit log."
      />
      {settings.isPending ? <LoadingState /> : null}
      {settings.isError ? <Alert tone="error">{describeError(settings.error)}</Alert> : null}
      {settings.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Value</th>
                <th scope="col">Last changed</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {settings.data.map((s) => (
                <tr key={s.key}>
                  <td>
                    <strong>{s.label}</strong>
                    <div className="secondary-text">{s.description}</div>
                  </td>
                  <td>
                    {shown(s.value)}
                    {s.isDefault ? (
                      <span className="muted"> (default)</span>
                    ) : (
                      <span className="muted"> (default {shown(s.default)})</span>
                    )}
                  </td>
                  <td>
                    {s.updatedAt ? `${formatDateTime(s.updatedAt)} · ${s.updatedBy?.fullName ?? ''}` : '—'}
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                      Change
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing ? (
        <EditSetting
          setting={editing}
          onClose={() => setEditing(null)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['settings'] })}
        />
      ) : null}
    </div>
  );
}

/** A setting with no value yet (for example a minimum Knutsford has not set) shows as "Not set". */
const shown = (value: unknown) => (value === null ? 'Not set' : String(value));

function EditSetting(props: { setting: Setting; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  // Settings whose default is "not set" may be cleared again by leaving the value empty.
  const clearable = props.setting.default === null;
  const [value, setValue] = useState(props.setting.value === null ? '' : String(props.setting.value));
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      title={props.setting.label}
      description={props.setting.description}
      submitLabel="Save"
      validate={() =>
        clearable && value.trim() === ''
          ? reason.trim().length < 5
            ? 'Explain the change, at least 5 characters.'
            : null
          : !/^\d+(\.\d+)?$/.test(value.trim())
            ? clearable
              ? 'Enter a number, or leave it empty for "not set".'
              : 'Enter a number.'
            : reason.trim().length < 5
              ? 'Explain the change, at least 5 characters.'
              : null
      }
      onSubmit={async () => {
        await auth.call(`/settings/${props.setting.key}`, {
          method: 'PUT',
          headers: { 'If-Match': String(props.setting.version) },
          body: {
            value: clearable && value.trim() === '' ? null : Number(value.trim()),
            reason: reason.trim(),
          },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field
        label={clearable ? 'Value (leave empty for not set)' : 'Value'}
        name="value"
        inputMode="numeric"
        value={value}
        onChange={setValue}
      />
      <Field
        label="Reason (recorded)"
        name="reason"
        multiline
        value={reason}
        onChange={setReason}
        maxLength={500}
      />
    </FormDialog>
  );
}
