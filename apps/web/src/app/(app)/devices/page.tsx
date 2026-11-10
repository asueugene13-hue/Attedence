'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface Device {
  id: string;
  platform: 'ANDROID' | 'IOS';
  model: string | null;
  status: 'PENDING_APPROVAL' | 'TRUSTED' | 'REVOKED' | 'REPLACED';
  isAttendanceDevice: boolean;
  trustRequestedAt: string | null;
  trustRequestReason: string | null;
  revokeReason: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  owner: { fullName: string; email: string; studentNumber: string | null };
}

const STATUS = {
  PENDING_APPROVAL: { label: 'Waiting for approval', tone: 'warning' },
  TRUSTED: { label: 'Trusted', tone: 'success' },
  REVOKED: { label: 'Revoked', tone: 'error' },
  REPLACED: { label: 'Replaced', tone: 'neutral' },
} as const;

export default function DevicesPage() {
  return (
    <PermissionGate permission="devices.approve">
      <Devices />
    </PermissionGate>
  );
}

/**
 * Students' attendance phones (D-10). A student's first phone is trusted automatically; a new phone
 * waits here until someone approves it, and then the old one is replaced. Lost phones are revoked.
 */
function Devices() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [view, setView] = useState('requested');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState<{ device: Device; kind: 'approve' | 'revoke' } | null>(null);
  const query =
    view === 'requested'
      ? 'requested=true'
      : `status=${view}${search ? `&q=${encodeURIComponent(search)}` : ''}`;
  const devices = useQuery({
    queryKey: ['devices', query],
    queryFn: () => auth.call<{ data: Device[] }>(`/devices?${query}`),
  });

  return (
    <div className="stack">
      <PageHeader
        title="Phones"
        subtitle="Each student has one attendance phone. Their first phone is trusted automatically; a new phone needs approval here, and the old one is then replaced."
      />
      <div className="row">
        <SelectField
          label="Show"
          name="view"
          value={view}
          onChange={setView}
          options={[
            { value: 'requested', label: 'Requests waiting for a decision' },
            { value: 'TRUSTED', label: 'Trusted phones' },
            { value: 'PENDING_APPROVAL', label: 'All phones waiting' },
            { value: 'REVOKED', label: 'Revoked' },
            { value: 'REPLACED', label: 'Replaced' },
          ]}
        />
        {view !== 'requested' ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <Field label="Student ID, name or email" name="q" value={q} onChange={setQ} />
            <Button type="submit" variant="secondary" style={{ alignSelf: 'flex-end' }}>
              Search
            </Button>
          </form>
        ) : null}
      </div>
      {devices.isPending ? <LoadingState /> : null}
      {devices.isError ? <Alert tone="error">{describeError(devices.error)}</Alert> : null}
      {devices.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Owner</th>
                <th scope="col">Phone</th>
                <th scope="col">Status</th>
                <th scope="col">{view === 'requested' ? 'Reason given' : 'Last used'}</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.data.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {view === 'requested' ? 'No requests are waiting.' : 'No phones found.'}
                  </td>
                </tr>
              ) : (
                devices.data.data.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.owner.fullName}
                      <div className="muted">
                        {d.owner.studentNumber ? `${d.owner.studentNumber} · ` : ''}
                        {d.owner.email}
                      </div>
                    </td>
                    <td>
                      {d.model ?? 'Unknown model'} ({d.platform === 'IOS' ? 'iPhone' : 'Android'})
                      <div className="muted">Registered {formatDateTime(d.createdAt)}</div>
                    </td>
                    <td>
                      <StatusBadge tone={STATUS[d.status].tone} label={STATUS[d.status].label} />
                      {d.isAttendanceDevice ? <div className="muted">Attendance phone</div> : null}
                    </td>
                    <td>
                      {view === 'requested'
                        ? `${d.trustRequestReason ?? ''} (${formatDateTime(d.trustRequestedAt)})`
                        : d.status === 'REVOKED'
                          ? (d.revokeReason ?? '—')
                          : formatDateTime(d.lastSeenAt)}
                    </td>
                    <td>
                      <div className="row">
                        {d.status === 'PENDING_APPROVAL' ? (
                          <Button size="sm" onClick={() => setActing({ device: d, kind: 'approve' })}>
                            Approve
                          </Button>
                        ) : null}
                        {d.status === 'PENDING_APPROVAL' || d.status === 'TRUSTED' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setActing({ device: d, kind: 'revoke' })}
                          >
                            {d.status === 'TRUSTED' ? 'Revoke' : 'Refuse'}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {acting ? (
        <DecisionDialog
          {...acting}
          onClose={() => setActing(null)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['devices'] })}
        />
      ) : null}
    </div>
  );
}

function DecisionDialog(props: {
  device: Device;
  kind: 'approve' | 'revoke';
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [text, setText] = useState('');
  const approve = props.kind === 'approve';
  const trusted = props.device.status === 'TRUSTED';
  return (
    <FormDialog
      open
      title={approve ? 'Approve this phone' : trusted ? 'Revoke this phone' : 'Refuse this phone'}
      description={
        approve
          ? `${props.device.owner.fullName}'s attendance phone becomes this one. Their current attendance phone, if any, is replaced and can no longer be used.`
          : trusted
            ? 'For a lost or stolen phone. It can no longer be used, and any new phone will need approval.'
            : 'The student is told it was refused; they can ask again.'
      }
      submitLabel={approve ? 'Approve' : trusted ? 'Revoke' : 'Refuse'}
      destructive={!approve}
      validate={() => (!approve && text.trim().length < 5 ? 'Give the reason, at least 5 characters.' : null)}
      onSubmit={async () => {
        await auth.call(`/devices/${props.device.id}/${approve ? 'approve' : 'revoke'}`, {
          method: 'POST',
          body: approve ? (text.trim() ? { note: text.trim() } : {}) : { reason: text.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field
        label={approve ? 'Note (optional, recorded)' : 'Reason (recorded)'}
        name="text"
        multiline
        value={text}
        onChange={setText}
        maxLength={500}
      />
    </FormDialog>
  );
}
