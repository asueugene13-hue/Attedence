'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { Counts, SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import {
  ASSIST_OPTIONS,
  evidenceSummary,
  RECORD_DISPLAY,
  REASON_LABELS,
  refreshAttendance,
  type RosterLine,
  timeOf,
  useLiveRoster,
} from '@/lib/attendance';
import { useAuth } from '@/lib/auth';

type Dialog =
  | { kind: 'reject'; line: RosterLine }
  | { kind: 'assist'; line: RosterLine }
  | { kind: 'correct'; line: RosterLine };

/** The live roster (ATTENDANCE_FLOW §6): who is here, with what evidence, and the lecturer's decisions. */
export default function RosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { roster, live, syncedAt, reload } = useLiveRoster(id);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow();

  if (roster.isPending) return <LoadingState label="Loading the roster…" />;
  if (roster.isError) return <Alert tone="error">{describeError(roster.error)}</Alert>;
  const r = roster.data;
  const s = r.session;
  const canDecide = auth.can('attendance.review_pending');
  const canAssist = auth.me?.activeRole === 'LECTURER' && auth.can('attendance.assisted_checkin');
  const canCorrect = auth.can('attendance.correct');
  const done = () => Promise.all([reload(), refreshAttendance(queryClient)]);

  async function approve(line: RosterLine) {
    setBusy(line.studentId);
    setError(null);
    try {
      await auth.call(`/attendance-records/${line.recordId}/decide`, {
        method: 'POST',
        body: { decision: 'APPROVE', version: line.version },
      });
      await done();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function approveWaiting() {
    setBusy('all');
    setError(null);
    try {
      const result = await auth.call<{ approved: number }>(`/attendance-sessions/${id}/approve-waiting`, {
        method: 'POST',
        body: {},
      });
      setNotice(`${result.approved} check-in${result.approved === 1 ? '' : 's'} approved.`);
      await done();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  const waiting = r.students.filter((l) => l.status === 'PENDING' || l.status === 'UNDER_REVIEW');
  const minutesLeft = Math.max(0, Math.ceil((Date.parse(s.closesAt) - now) / 60_000));
  return (
    <div className="stack">
      <PageHeader
        title="Live roster"
        subtitle={`Opened ${timeOf(s.openedAt)} · late after ${timeOf(s.lateAfter)} · ${
          s.status === 'OPEN' ? `closes ${timeOf(s.closesAt)} (${minutesLeft} min left)` : 'attendance closed'
        }`}
      />
      <p role="status" className="muted">
        {live === 'live'
          ? `Live${syncedAt ? ` · updated ${Math.max(0, Math.round((now - syncedAt) / 1000))} s ago` : ''}`
          : live === 'connecting'
            ? 'Connecting…'
            : 'Reconnecting… the roster refreshes every minute meanwhile.'}{' '}
        <Link href={`/classes/${s.classSessionId}`}>Back to the class</Link>
        {s.status === 'OPEN' && auth.me?.activeRole === 'LECTURER' ? (
          <>
            {' · '}
            <Link href={`/attendance-code/${id}`} target="_blank" rel="noopener">
              Show the code (projector)
            </Link>
          </>
        ) : null}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {r.degraded ? (
        <Alert tone="warning">
          The classroom beacon is not working, so check-ins wait for you instead of being rejected.
          {canDecide ? (
            <>
              {' '}
              <Button size="sm" busy={busy === 'all'} onClick={() => void approveWaiting()}>
                Approve all waiting because of the beacon
              </Button>
            </>
          ) : null}
        </Alert>
      ) : null}

      <section className="card">
        <div className="card-body">
          <Counts
            items={[
              { label: 'Enrolled', value: r.counts.enrolled ?? 0 },
              { label: 'Present', value: r.counts.PRESENT ?? 0 },
              { label: 'Late', value: r.counts.LATE ?? 0 },
              { label: 'Waiting', value: waiting.length },
              { label: 'Not accepted', value: r.counts.REJECTED ?? 0 },
              { label: 'Not checked in', value: (r.counts.notCheckedIn ?? 0) + (r.counts.ABSENT ?? 0) },
            ]}
          />
        </div>
      </section>

      <div className="table-wrap">
        <table className="data">
          <caption className="muted">Students waiting for a decision are listed first.</caption>
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Status</th>
              <th scope="col">Checked in</th>
              <th scope="col">Evidence</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {[...waiting, ...r.students.filter((l) => !waiting.includes(l))].map((line) => {
              const display = RECORD_DISPLAY[line.status ?? 'NONE'];
              const isWaiting = line.status === 'PENDING' || line.status === 'UNDER_REVIEW';
              const missing = line.status === null || line.status === 'ABSENT' || line.status === 'REJECTED';
              return (
                <tr key={line.studentId}>
                  <td>
                    {line.fullName}
                    <div className="muted">{line.studentNumber}</div>
                  </td>
                  <td>
                    <StatusBadge tone={display.tone} label={display.label} />
                    {line.lastAttempt?.reason ? (
                      <div className="muted">
                        {REASON_LABELS[line.lastAttempt.reason] ?? line.lastAttempt.reason}
                      </div>
                    ) : null}
                  </td>
                  <td>{line.checkedInAt ? timeOf(line.checkedInAt) : '—'}</td>
                  <td>
                    {evidenceSummary(line) || '—'}
                    {line.attempts > 1 ? <div className="muted">{line.attempts} tries</div> : null}
                  </td>
                  <td>
                    <div className="row">
                      {isWaiting && canDecide ? (
                        <>
                          <Button size="sm" busy={busy === line.studentId} onClick={() => void approve(line)}>
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setDialog({ kind: 'reject', line })}
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                      {missing && canAssist ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDialog({ kind: 'assist', line })}
                        >
                          Check in by hand
                        </Button>
                      ) : null}
                      {!isWaiting &&
                      line.recordId &&
                      canCorrect &&
                      line.status !== 'VOIDED' &&
                      line.status !== 'EXCUSED' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDialog({ kind: 'correct', line })}
                        >
                          Correct
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'reject' ? (
        <ReasonDialog
          title={`Reject ${dialog.line.fullName}’s check-in`}
          description="The student will see that their check-in was not accepted. Your note is recorded."
          submitLabel="Reject"
          onSubmit={(note) =>
            auth.call(`/attendance-records/${dialog.line.recordId}/decide`, {
              method: 'POST',
              body: { decision: 'REJECT', note, version: dialog.line.version },
            })
          }
          onClose={() => setDialog(null)}
          onDone={done}
        />
      ) : null}
      {dialog?.kind === 'assist' ? (
        <AssistDialog
          line={dialog.line}
          attendanceSessionId={id}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      ) : null}
      {dialog?.kind === 'correct' ? (
        <CorrectDialog
          line={dialog.line}
          onClose={() => setDialog(null)}
          onDone={done}
          onRequested={setNotice}
        />
      ) : null}
    </div>
  );
}

/** The current time, ticking every second, for "minutes left" and "updated … ago". */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function ReasonDialog(props: {
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (reason: string) => Promise<unknown>;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      destructive
      title={props.title}
      description={props.description}
      submitLabel={props.submitLabel}
      validate={() => (reason.trim().length < 5 ? 'Give a reason, at least 5 characters.' : null)}
      onSubmit={async () => {
        await props.onSubmit(reason.trim());
        await props.onDone();
      }}
      onClose={props.onClose}
    >
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

function AssistDialog(props: {
  line: RosterLine;
  attendanceSessionId: string;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [method, setMethod] = useState('');
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      title={`Check in ${props.line.fullName} by hand`}
      description="For a student who is here but cannot check in with their phone. How and why are recorded."
      submitLabel="Check in"
      validate={() =>
        !method ? 'Choose how.' : reason.trim().length < 5 ? 'Give a reason, at least 5 characters.' : null
      }
      onSubmit={async () => {
        await auth.call(`/attendance-sessions/${props.attendanceSessionId}/assisted-check-ins`, {
          method: 'POST',
          body: { studentId: props.line.studentId, method, reason: reason.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <SelectField
        label="How"
        name="method"
        value={method}
        onChange={setMethod}
        options={ASSIST_OPTIONS}
        placeholder="Choose…"
        required
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

function CorrectDialog(props: {
  line: RosterLine;
  onClose: () => void;
  onDone: () => Promise<unknown>;
  onRequested: (message: string) => void;
}) {
  const auth = useAuth();
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const options = (['PRESENT', 'LATE', 'ABSENT', 'REJECTED'] as const)
    .filter((s) => s !== props.line.status)
    .map((s) => ({ value: s, label: RECORD_DISPLAY[s].label }));
  return (
    <FormDialog
      open
      title={`Correct ${props.line.fullName}’s attendance`}
      description="The change, your reason and your name are recorded. After the correction window, it waits for an administrator."
      submitLabel="Save correction"
      validate={() =>
        !status
          ? 'Choose the correct status.'
          : reason.trim().length < 5
            ? 'Give a reason, at least 5 characters.'
            : null
      }
      onSubmit={async () => {
        const result = await auth.call<{ applied: boolean }>(
          `/attendance-records/${props.line.recordId}/correct`,
          {
            method: 'POST',
            body: { status, reason: reason.trim(), version: props.line.version },
          },
        );
        if (!result.applied)
          props.onRequested(
            'The correction window has passed, so your correction is waiting for an administrator.',
          );
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <SelectField
        label="Correct status"
        name="status"
        value={status}
        onChange={setStatus}
        options={options}
        placeholder="Choose…"
        required
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
