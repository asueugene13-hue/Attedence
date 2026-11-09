'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { classLabel, classTime, type RescheduleRequestView } from '@/lib/classes';
import { formatDateTime } from '@/lib/format';

const STATUS_TONE = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  WITHDRAWN: 'neutral',
} as const;
const STATUS_LABEL = {
  PENDING: 'Waiting',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

/**
 * Reschedule requests (D-11). Administrators approve or reject after seeing a fresh conflict check;
 * lecturers see their own requests and may withdraw one that is still waiting.
 */
export default function RescheduleRequestsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.can('class_sessions.reschedule');
  const [status, setStatus] = useState('PENDING');
  const [acting, setActing] = useState<{ request: RescheduleRequestView; kind: 'approve' | 'reject' } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const requests = useQuery({
    queryKey: ['reschedule-requests', status],
    queryFn: () =>
      auth.call<{ data: RescheduleRequestView[] }>(
        `/reschedule-requests${status ? `?status=${status}` : ''}`,
      ),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['reschedule-requests'] });

  async function withdraw(id: string) {
    setError(null);
    try {
      await auth.call(`/reschedule-requests/${id}/withdraw`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Reschedule requests"
        subtitle={
          isAdmin
            ? 'Requests from lecturers to move a class. Each is checked for room, lecturer and student clashes before you decide.'
            : 'Your requests to move a class. To ask for a new one, open the class and choose “Ask to reschedule”.'
        }
      />
      <SelectField
        label="Show"
        name="status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'PENDING', label: 'Waiting' },
          { value: 'APPROVED', label: 'Approved' },
          { value: 'REJECTED', label: 'Rejected' },
          { value: 'WITHDRAWN', label: 'Withdrawn' },
          { value: '', label: 'All' },
        ]}
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {requests.isPending ? <LoadingState /> : null}
      {requests.isError ? <Alert tone="error">{describeError(requests.error)}</Alert> : null}
      {requests.data?.data.length === 0 ? <p className="muted">No requests.</p> : null}
      {requests.data?.data.map((r) => (
        <section
          key={r.id}
          className="card"
          aria-label={`Request for ${r.classSession ? classLabel(r.classSession) : 'class'}`}
        >
          <div className="card-header">
            <h2>
              {r.classSession ? (
                <Link href={`/classes/${r.classSession.id}`}>{classLabel(r.classSession)}</Link>
              ) : (
                'Class'
              )}
            </h2>
            <StatusBadge
              tone={STATUS_TONE[r.status]}
              label={r.isDirect ? 'Rescheduled directly' : STATUS_LABEL[r.status]}
            />
          </div>
          <div className="card-body stack-sm">
            <p>
              From {r.classSession ? classTime(r.classSession) : '—'} to{' '}
              <strong>
                {classTime({
                  scheduledStart: r.proposedStart,
                  scheduledEnd: r.proposedEnd,
                  expectedStart: null,
                })}
              </strong>
              {r.proposedClassroom ? `, ${r.proposedClassroom.code} · ${r.proposedClassroom.name}` : ''}
            </p>
            <p className="secondary-text">
              Reason: {r.reason} · asked {formatDateTime(r.createdAt)}
            </p>
            {r.decisionNote ? <p className="secondary-text">Decision note: {r.decisionNote}</p> : null}
            {r.status === 'PENDING' ? (
              <div className="row">
                {isAdmin ? (
                  <>
                    <Button size="sm" onClick={() => setActing({ request: r, kind: 'approve' })}>
                      Review and approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setActing({ request: r, kind: 'reject' })}
                    >
                      Reject
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => void withdraw(r.id)}>
                    Withdraw
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        </section>
      ))}
      {acting ? <DecisionDialog {...acting} onClose={() => setActing(null)} onDone={refresh} /> : null}
    </div>
  );
}

function DecisionDialog(props: {
  request: RescheduleRequestView;
  kind: 'approve' | 'reject';
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [note, setNote] = useState('');
  const fresh = useQuery({
    queryKey: ['reschedule-request', props.request.id],
    queryFn: () => auth.call<RescheduleRequestView>(`/reschedule-requests/${props.request.id}`),
    enabled: props.kind === 'approve',
  });
  const check = fresh.data?.check;
  return (
    <FormDialog
      open
      title={props.kind === 'approve' ? 'Approve reschedule' : 'Reject reschedule'}
      description={
        props.kind === 'approve'
          ? 'Approving creates the replacement class and tells everyone. The original class is kept in the history.'
          : 'The lecturer is told, with your note.'
      }
      submitLabel={props.kind === 'approve' ? 'Approve' : 'Reject'}
      destructive={props.kind === 'reject'}
      validate={() =>
        props.kind === 'reject' && note.trim().length < 5
          ? 'Explain why, at least 5 characters.'
          : check && check.blockers.length > 0
            ? 'This time is blocked; it cannot be approved.'
            : null
      }
      onSubmit={async () => {
        await auth.call(`/reschedule-requests/${props.request.id}/${props.kind}`, {
          method: 'POST',
          body: note.trim() ? { note: note.trim() } : {},
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      {props.kind === 'approve' ? (
        fresh.isPending ? (
          <LoadingState label="Checking for conflicts…" />
        ) : check ? (
          <>
            {check.blockers.length === 0 && check.warnings.length === 0 ? (
              <Alert tone="success">No conflicts found.</Alert>
            ) : null}
            {check.blockers.map((b) => (
              <Alert key={b.code} tone="error">
                {b.message}
              </Alert>
            ))}
            {check.warnings.map((w) => (
              <Alert key={w.code} tone="warning">
                {w.message}
              </Alert>
            ))}
          </>
        ) : null
      ) : null}
      <Field
        label={props.kind === 'reject' ? 'Why (sent to the lecturer)' : 'Note (optional)'}
        name="note"
        multiline
        value={note}
        onChange={setNote}
        maxLength={500}
      />
    </FormDialog>
  );
}
