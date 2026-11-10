'use client';

import { RISK_TYPES } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface Flag {
  id: string;
  type: (typeof RISK_TYPES)[number];
  severity: string;
  status: 'OPEN' | 'DISMISSED' | 'CONFIRMED';
  student: { id: string; studentNumber: string; fullName: string } | null;
  evidence: Record<string, unknown>;
  reviewedBy: { fullName: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

const TYPE_LABELS: Record<(typeof RISK_TYPES)[number], string> = {
  SHARED_DEVICE: 'One phone, several students',
  ACCOUNT_SWITCH: 'Quick switch between student accounts on one phone',
  DEVICE_SWITCH: 'Frequent phone changes',
  BEACON_LOCATION_CONFLICT: 'Beacon heard far from campus',
  MOCK_LOCATION: 'Fake location app',
  INTEGRITY_FAILED: 'App or phone integrity check failed',
  REPEATED_REJECTIONS: 'Many rejected check-ins',
  UNEXPECTED_BEACON: 'Beacon heard in an unexpected place',
};

export default function RiskFlagsPage() {
  return (
    <PermissionGate permission="risk_flags.review">
      <RiskFlags />
    </PermissionGate>
  );
}

/** Things worth a person's attention. A flag never changes attendance or access by itself. */
function RiskFlags() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const [reviewing, setReviewing] = useState<Flag | null>(null);
  const flags = useQuery({
    queryKey: ['risk-flags', status],
    queryFn: () => auth.call<{ data: Flag[] }>(`/risk-flags?status=${status}`),
  });

  return (
    <div className="stack">
      <PageHeader
        title="Risk flags"
        subtitle="Things worth checking, such as one phone used by several students. A flag never changes anyone's attendance or access by itself: you decide, with a note."
      />
      <SelectField
        label="Show"
        name="status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'OPEN', label: 'Waiting for review' },
          { value: 'CONFIRMED', label: 'Confirmed' },
          { value: 'DISMISSED', label: 'Dismissed' },
        ]}
      />
      {flags.isPending ? <LoadingState /> : null}
      {flags.isError ? <Alert tone="error">{describeError(flags.error)}</Alert> : null}
      {flags.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Raised</th>
                <th scope="col">What</th>
                <th scope="col">Student</th>
                <th scope="col">{status === 'OPEN' ? 'Details' : 'Review'}</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {flags.data.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {status === 'OPEN' ? 'Nothing is waiting for review.' : 'None.'}
                  </td>
                </tr>
              ) : (
                flags.data.data.map((f) => (
                  <tr key={f.id}>
                    <td>{formatDateTime(f.createdAt)}</td>
                    <td>
                      {TYPE_LABELS[f.type]}
                      <div>
                        <StatusBadge tone={f.severity === 'HIGH' ? 'error' : 'warning'} label={f.severity} />
                      </div>
                    </td>
                    <td>{f.student ? `${f.student.fullName} (${f.student.studentNumber})` : '—'}</td>
                    <td className="secondary-text">
                      {status === 'OPEN'
                        ? describeEvidence(f)
                        : `${f.reviewNote ?? ''} · ${f.reviewedBy?.fullName ?? ''}, ${formatDateTime(f.reviewedAt)}`}
                    </td>
                    <td>
                      {f.status === 'OPEN' ? (
                        <Button size="sm" variant="secondary" onClick={() => setReviewing(f)}>
                          Review
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {reviewing ? (
        <ReviewDialog
          flag={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['risk-flags'] })}
        />
      ) : null}
    </div>
  );
}

function describeEvidence(f: Flag) {
  const e = f.evidence;
  if (Array.isArray(e.students)) return `${e.students.length} student accounts on one phone.`;
  if (typeof e.requestsIn90Days === 'number') return `${e.requestsIn90Days} new-phone requests in 90 days.`;
  return '';
}

function ReviewDialog(props: { flag: Flag; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const [decision, setDecision] = useState('DISMISSED');
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      title="Review this flag"
      description={`${TYPE_LABELS[props.flag.type]}. Confirming records that it was a real problem; it changes nothing else. Act separately (for example revoke a phone) if needed.`}
      submitLabel="Record review"
      validate={() => (note.trim().length < 5 ? 'Write a note, at least 5 characters.' : null)}
      onSubmit={async () => {
        await auth.call(`/risk-flags/${props.flag.id}/review`, {
          method: 'POST',
          body: { decision, note: note.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <SelectField
        label="Decision"
        name="decision"
        value={decision}
        onChange={setDecision}
        options={[
          { value: 'DISMISSED', label: 'Dismiss: not a problem' },
          { value: 'CONFIRMED', label: 'Confirm: a real problem' },
        ]}
      />
      <Field label="Note (recorded)" name="note" multiline value={note} onChange={setNote} maxLength={500} />
    </FormDialog>
  );
}
