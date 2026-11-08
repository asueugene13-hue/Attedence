'use client';

import { STAFF_ADMIN_ROLES, type StaffAdminRole } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { Alert, Button, LoadingState, PageHeader, UserStatusBadge } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, roleLabel } from '@/lib/format';
import type { UserDetail } from '@/lib/types';

type Action =
  | { kind: 'suspend' | 'restore' | 'mfa-reset' }
  | { kind: 'grant'; role: StaffAdminRole }
  | { kind: 'revoke'; grantId: string; role: string };

export default function UserDetailPage() {
  return (
    <PermissionGate permission="users.manage_admins">
      <Suspense fallback={<LoadingState />}>
        <UserDetailView />
      </Suspense>
    </PermissionGate>
  );
}

function UserDetailView() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created');
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [grantRole, setGrantRole] = useState<StaffAdminRole | ''>('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({ queryKey: ['user', id], queryFn: () => auth.call<UserDetail>(`/users/${id}`) });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <Alert tone="error">{describeError(query.error)}</Alert>;
  const user = query.data;
  const isSelf = user.id === auth.me?.user.id;
  const heldRoles = new Set(user.roles.map((r) => r.role));
  const grantable = STAFF_ADMIN_ROLES.filter((r) => !heldRoles.has(r));

  async function refresh(updated: UserDetail) {
    queryClient.setQueryData(['user', id], updated);
    await queryClient.invalidateQueries({ queryKey: ['users'] });
  }

  async function run(reason: string) {
    if (!action) return;
    const paths: Record<Action['kind'], string> = {
      suspend: `/users/${id}/suspend`,
      restore: `/users/${id}/restore`,
      'mfa-reset': `/users/${id}/mfa/reset`,
      grant: `/users/${id}/roles`,
      revoke: action.kind === 'revoke' ? `/users/${id}/roles/${action.grantId}/revoke` : '',
    };
    const body = action.kind === 'grant' ? { role: action.role, reason } : { reason };
    await refresh(await auth.call<UserDetail>(paths[action.kind], { method: 'POST', body }));
    setNotice(
      {
        suspend: 'Account suspended. The person has been signed out everywhere.',
        restore: 'Account restored.',
        'mfa-reset': 'Two-step sign-in reset. The person will set it up again at their next sign-in.',
        grant: 'Role granted.',
        revoke: 'Role removed. Sessions using it have ended.',
      }[action.kind],
    );
  }

  async function resendActivation() {
    setError(null);
    setNotice(null);
    try {
      await auth.call(`/users/${id}/activation-email`, { method: 'POST' });
      setNotice('A new activation email has been sent. Earlier links no longer work.');
    } catch (err) {
      setError(describeError(err));
    }
  }

  const dialog = action
    ? {
        suspend: {
          title: `Suspend ${user.fullName}?`,
          description: 'They are signed out at once and cannot sign in until restored.',
          confirm: 'Suspend account',
          destructive: true,
        },
        restore: {
          title: `Restore ${user.fullName}?`,
          description: 'They will be able to sign in again.',
          confirm: 'Restore account',
          destructive: false,
        },
        'mfa-reset': {
          title: 'Reset two-step sign-in?',
          description:
            'Use this when the person lost their phone. Their recovery codes stop working and they are signed out.',
          confirm: 'Reset two-step sign-in',
          destructive: true,
        },
        grant: {
          title: `Grant ${action.kind === 'grant' ? roleLabel(action.role) : ''}?`,
          description:
            'The role applies across the whole university. Faculty and department scopes arrive later.',
          confirm: 'Grant role',
          destructive: false,
        },
        revoke: {
          title: `Remove ${action.kind === 'revoke' ? action.role : ''}?`,
          description: 'Any session acting in this role ends now.',
          confirm: 'Remove role',
          destructive: true,
        },
      }[action.kind]
    : null;

  return (
    <div className="stack">
      <PageHeader
        title={user.fullName}
        subtitle={user.email}
        actions={
          <>
            {user.status === 'PENDING_ACTIVATION' ? (
              <Button variant="secondary" onClick={resendActivation}>
                Resend activation email
              </Button>
            ) : null}
            {user.mfaEnabled && !isSelf ? (
              <Button variant="danger" onClick={() => setAction({ kind: 'mfa-reset' })}>
                Reset two-step sign-in
              </Button>
            ) : null}
            {user.status === 'SUSPENDED' ? (
              <Button variant="secondary" onClick={() => setAction({ kind: 'restore' })}>
                Restore account
              </Button>
            ) : !isSelf && user.status !== 'DEACTIVATED' ? (
              <Button variant="danger" onClick={() => setAction({ kind: 'suspend' })}>
                Suspend account
              </Button>
            ) : null}
          </>
        }
      />
      <Link href="/admin/users">← All accounts</Link>

      {created === 'sent' ? (
        <Alert tone="success">Account created. An activation email has been sent.</Alert>
      ) : null}
      {created === 'unsent' ? (
        <Alert tone="warning">
          Account created, but the activation email could not be sent. Use “Resend activation email”.
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="card" aria-labelledby="account-heading">
        <div className="card-header">
          <h2 id="account-heading">Account</h2>
          <span className="spacer" />
          <UserStatusBadge status={user.status} />
        </div>
        <dl className="card-body details">
          <dt>Phone</dt>
          <dd>{user.phone ?? '—'}</dd>
          <dt>Two-step sign-in</dt>
          <dd>{user.mfaEnabled ? 'Set up' : 'Not set up'}</dd>
          <dt>Last sign-in</dt>
          <dd>{formatDateTime(user.lastLoginAt)}</dd>
          <dt>Signed in on</dt>
          <dd>{user.activeSessions === 1 ? '1 device' : `${user.activeSessions} devices`}</dd>
          <dt>Created</dt>
          <dd>{formatDateTime(user.createdAt)}</dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="roles-heading">
        <div className="card-header">
          <h2 id="roles-heading">Roles</h2>
        </div>
        <div className="card-body stack">
          {user.roles.length === 0 ? <p className="muted">No roles.</p> : null}
          {user.roles.map((grant) => (
            <div key={grant.grantId} className="row">
              <span className="badge badge-info">{roleLabel(grant.role)}</span>
              <span className="muted">Whole university · since {formatDateTime(grant.grantedAt)}</span>
              <span className="spacer" />
              {!(isSelf && grant.role === 'SUPER_ADMIN') ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    setAction({ kind: 'revoke', grantId: grant.grantId, role: roleLabel(grant.role) })
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
          {grantable.length > 0 && user.status !== 'DEACTIVATED' ? (
            <div className="row">
              <div className="field">
                <label htmlFor="grant-role">Add a role</label>
                <select
                  id="grant-role"
                  value={grantRole}
                  onChange={(e) => setGrantRole(e.target.value as StaffAdminRole)}
                >
                  <option value="">Choose a role</option>
                  {grantable.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                variant="secondary"
                style={{ alignSelf: 'flex-end' }}
                disabled={!grantRole}
                onClick={() => grantRole && setAction({ kind: 'grant', role: grantRole })}
              >
                Grant role
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card" aria-labelledby="history-heading">
        <div className="card-header">
          <h2 id="history-heading">Role history</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Granted</th>
                <th scope="col">By</th>
                <th scope="col">Removed</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {user.grantHistory.map((g) => (
                <tr key={g.grantId}>
                  <td>{roleLabel(g.role)}</td>
                  <td>{formatDateTime(g.grantedAt)}</td>
                  <td className="secondary-text">{g.grantedBy?.email ?? 'System'}</td>
                  <td>{formatDateTime(g.revokedAt)}</td>
                  <td className="secondary-text">{g.revokedBy?.email ?? (g.revokedAt ? 'System' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {dialog ? (
        <ReasonDialog
          open
          title={dialog.title}
          description={dialog.description}
          confirmLabel={dialog.confirm}
          destructive={dialog.destructive}
          onConfirm={async (reason) => {
            setNotice(null);
            setError(null);
            await run(reason);
            setGrantRole('');
          }}
          onClose={() => setAction(null)}
        />
      ) : null}
    </div>
  );
}
