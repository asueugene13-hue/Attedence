'use client';

import type { RoleKey } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { RoleView } from '@/lib/types';

export default function RolesPage() {
  return (
    <PermissionGate permission="roles.edit_permissions">
      <RolesEditor />
    </PermissionGate>
  );
}

function RolesEditor() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['roles'], queryFn: () => auth.call<RoleView[]>('/roles') });
  const [selected, setSelected] = useState<RoleKey>('UNIVERSITY_ADMIN');
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <Alert tone="error">{describeError(query.error)}</Alert>;

  const role = query.data.find((r) => r.key === selected) ?? query.data[0]!;
  const working = draft[role.key] ?? new Set(role.permissions);
  const changed =
    working.size !== role.permissions.length || role.permissions.some((key) => !working.has(key));

  function toggle(key: string) {
    const next = new Set(working);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setDraft((d) => ({ ...d, [role.key]: next }));
    setNotice(null);
  }

  return (
    <div className="stack">
      <PageHeader
        title="Roles and permissions"
        subtitle="Choose what each role may do. Only permissions allowed for a role by the permission matrix are offered."
      />
      <div className="row" role="tablist" aria-label="Roles">
        {query.data.map((r) => (
          <Button
            key={r.key}
            role="tab"
            aria-selected={r.key === role.key}
            variant={r.key === role.key ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setSelected(r.key)}
          >
            {r.name}
          </Button>
        ))}
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!role.editable ? (
        <Alert tone="info">
          The Super Admin role&apos;s permissions are fixed, so the installation can never be locked out.
        </Alert>
      ) : null}

      <section className="card" aria-labelledby="perm-heading">
        <div className="card-header">
          <h2 id="perm-heading">{role.name}</h2>
          <span className="muted">
            {working.size} of {role.assignable.length} permissions
          </span>
          <span className="spacer" />
          {role.editable ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={!changed}
                onClick={() => setDraft((d) => ({ ...d, [role.key]: new Set(role.permissions) }))}
              >
                Undo changes
              </Button>
              <Button size="sm" disabled={!changed} onClick={() => setConfirming(true)}>
                Save changes
              </Button>
            </>
          ) : null}
        </div>
        <div className="card-body permission-list">
          {role.assignable.map((p) => (
            <label key={p.key} className="checkbox">
              <input
                type="checkbox"
                checked={working.has(p.key)}
                disabled={!role.editable}
                onChange={() => toggle(p.key)}
              />
              <span>
                {p.description}
                <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                  {p.key}
                  {p.isDefault ? ' · default' : ' · optional'}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <ReasonDialog
        open={confirming}
        title={`Save permissions for ${role.name}?`}
        description="The change takes effect immediately for everyone acting in this role."
        confirmLabel="Save permissions"
        onConfirm={async (reason) => {
          const updated = await auth.call<RoleView>(`/roles/${role.key}/permissions`, {
            method: 'PUT',
            body: { permissions: [...working], reason },
          });
          queryClient.setQueryData<RoleView[]>(['roles'], (all) =>
            all?.map((r) => (r.key === updated.key ? updated : r)),
          );
          setDraft((d) => {
            const { [role.key]: _saved, ...rest } = d;
            return rest;
          });
          setNotice(`Permissions for ${role.name} saved.`);
        }}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
