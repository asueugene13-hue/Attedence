'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { RECORD_DISPLAY, type RecordStatus } from '@/lib/attendance';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface CorrectionRequest {
  id: string;
  recordId: string;
  classSessionId: string;
  from: RecordStatus;
  to: RecordStatus;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  student: { studentNumber: string; fullName: string };
  requestedBy: { fullName: string };
}

const STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Waiting' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

/**
 * Late attendance corrections (ATTENDANCE_FLOW §7): a lecturer's correction made after the correction
 * window waits here for an administrator. Lecturers see their own requests and how they were decided.
 */
export default function AttendanceCorrectionsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('PENDING');
  const [rejecting, setRejecting] = useState<CorrectionRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = auth.me?.activeRole === 'SUPER_ADMIN' || auth.me?.activeRole === 'UNIVERSITY_ADMIN';
  const requests = useQuery({
    queryKey: ['attendance', 'correction-requests', status],
    queryFn: () =>
      auth.call<{ data: CorrectionRequest[] }>(`/attendance-correction-requests?status=${status}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['attendance'] });

  async function approve(r: CorrectionRequest) {
    setBusy(r.id);
    setError(null);
    try {
      await auth.call(`/attendance-correction-requests/${r.id}/decide`, {
        method: 'POST',
        body: { decision: 'APPROVE' },
      });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Attendance corrections"
        subtitle={
          isAdmin
            ? 'Corrections lecturers made after the correction window. Nothing changes until you approve.'
            : 'Your corrections made after the correction window, and how they were decided.'
        }
      />
      <div style={{ maxWidth: 240 }}>
        <SelectField
          label="Show"
          name="status"
          value={status}
          onChange={setStatus}
          options={STATUS_OPTIONS}
        />
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {requests.isPending ? <LoadingState /> : null}
      {requests.isError ? <Alert tone="error">{describeError(requests.error)}</Alert> : null}
      {requests.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Student</th>
                <th scope="col">Change</th>
                <th scope="col">Reason</th>
                <th scope="col">Asked</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.data.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Nothing here.
                  </td>
                </tr>
              ) : (
                requests.data.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.student.fullName}
                      <div className="muted">{r.student.studentNumber}</div>
                    </td>
                    <td>
                      <StatusBadge tone={RECORD_DISPLAY[r.from].tone} label={RECORD_DISPLAY[r.from].label} />{' '}
                      → <StatusBadge tone={RECORD_DISPLAY[r.to].tone} label={RECORD_DISPLAY[r.to].label} />
                      <div>
                        <Link href={`/classes/${r.classSessionId}`}>The class</Link>
                      </div>
                    </td>
                    <td>
                      {r.reason}
                      {r.decisionNote ? <div className="muted">Decision: {r.decisionNote}</div> : null}
                    </td>
                    <td>
                      {formatDateTime(r.requestedAt)}
                      <div className="muted">{r.requestedBy.fullName}</div>
                    </td>
                    <td>
                      {isAdmin && r.status === 'PENDING' ? (
                        <div className="row">
                          <Button size="sm" busy={busy === r.id} onClick={() => void approve(r)}>
                            Approve
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setRejecting(r)}>
                            Reject
                          </Button>
                        </div>
                      ) : r.decidedAt ? (
                        <span className="muted">{formatDateTime(r.decidedAt)}</span>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {rejecting ? (
        <RejectDialog request={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />
      ) : null}
    </div>
  );
}

function RejectDialog(props: {
  request: CorrectionRequest;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      destructive
      title="Reject the correction"
      description="The record stays as it is, and the lecturer is told why."
      submitLabel="Reject"
      validate={() => (note.trim().length < 5 ? 'Say why, at least 5 characters.' : null)}
      onSubmit={async () => {
        await auth.call(`/attendance-correction-requests/${props.request.id}/decide`, {
          method: 'POST',
          body: { decision: 'REJECT', note: note.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field
        label="Why (sent to the lecturer)"
        name="note"
        multiline
        value={note}
        onChange={setNote}
        maxLength={500}
      />
    </FormDialog>
  );
}
