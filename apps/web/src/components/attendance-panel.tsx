'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { StatusBadge } from '@/components/records';
import { Alert, Button, Field } from '@/components/ui';
import { describeError } from '@/lib/api';
import {
  type AttendanceSessionView,
  CLOSE_REASON_LABELS,
  RECORD_DISPLAY,
  refreshAttendance,
  timeOf,
} from '@/lib/attendance';
import { useAuth } from '@/lib/auth';
import type { ClassSessionView } from '@/lib/classes';

/** Classes whose lecturer may still start them (the API checks the exact timing rules). */
const STARTABLE = ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED', 'UNDER_REVIEW'];

/**
 * Attendance for one class (ATTENDANCE_FLOW §1, §5): open it (with the class start, by default), then
 * the live roster and the projector code; close, extend, or reopen once. Buttons appear only for
 * what the person may do; the API checks every request.
 */
export function AttendancePanel({ session }: { session: ClassSessionView }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const attendance = useQuery({
    queryKey: ['attendance', 'class', session.id],
    queryFn: () =>
      auth.call<{ data: AttendanceSessionView | null }>(`/class-sessions/${session.id}/attendance`),
    refetchInterval: 30_000,
  });
  const [dialog, setDialog] = useState<'open' | 'extend' | 'reopen' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLecturer = auth.me?.activeRole === 'LECTURER' && auth.can('attendance.open');
  const refresh = () => refreshAttendance(queryClient);

  if (attendance.isError) return <Alert tone="error">{describeError(attendance.error)}</Alert>;
  if (attendance.isPending) return <p className="muted">Loading attendance…</p>;
  const a = attendance.data.data;

  async function close() {
    setBusy(true);
    setError(null);
    try {
      await auth.call(`/attendance-sessions/${a!.id}/close`, { method: 'POST', body: {} });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const canOpen = isLecturer && !a && (session.status === 'ACTIVE' || STARTABLE.includes(session.status));
  return (
    <section className="card" aria-labelledby="attendance-heading">
      <div className="card-header">
        <h2 id="attendance-heading">Attendance</h2>
        {a ? (
          <StatusBadge
            tone={a.status === 'OPEN' ? 'success' : 'neutral'}
            label={a.status === 'OPEN' ? 'Open' : 'Closed'}
          />
        ) : null}
      </div>
      <div className="card-body stack">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!a ? (
          <p className="muted">Attendance has not been taken for this class.</p>
        ) : (
          <>
            <dl className="details">
              <dt>Opened</dt>
              <dd>{timeOf(a.openedAt)}</dd>
              <dt>Late after</dt>
              <dd>{timeOf(a.lateAfter)}</dd>
              <dt>{a.status === 'OPEN' ? 'Closes' : 'Closed at'}</dt>
              <dd>
                {a.status === 'OPEN'
                  ? timeOf(a.closesAt)
                  : `${timeOf(a.closedAt!)} (${a.closeReason ? CLOSE_REASON_LABELS[a.closeReason] : ''})`}
              </dd>
            </dl>
            <p>
              {(Object.keys(RECORD_DISPLAY) as (keyof typeof RECORD_DISPLAY)[])
                .filter((k) => k !== 'NONE' && a.counts[k as keyof typeof a.counts])
                .map((k) => `${RECORD_DISPLAY[k].label}: ${a.counts[k as keyof typeof a.counts]}`)
                .join(' · ') || 'No check-ins yet.'}
            </p>
            <div className="row">
              <Link className="btn btn-primary" href={`/attendance/${a.id}`}>
                Live roster
              </Link>
              {isLecturer && a.status === 'OPEN' ? (
                <>
                  <Link
                    className="btn btn-secondary"
                    href={`/attendance/${a.id}/qr`}
                    target="_blank"
                    rel="noopener"
                  >
                    Show the code (projector)
                  </Link>
                  <Button variant="secondary" onClick={() => setDialog('extend')}>
                    Extend
                  </Button>
                  <Button variant="secondary" busy={busy} onClick={() => void close()}>
                    Close attendance
                  </Button>
                </>
              ) : null}
              {isLecturer &&
              a.status === 'CLOSED' &&
              !a.reopenedAt &&
              a.closeReason !== 'CLASS_VOIDED' &&
              session.status === 'ACTIVE' ? (
                <Button variant="secondary" onClick={() => setDialog('reopen')}>
                  Reopen (once)
                </Button>
              ) : null}
            </div>
          </>
        )}
        {canOpen ? (
          <Button onClick={() => setDialog('open')}>
            {session.status === 'ACTIVE' ? 'Open attendance' : 'Start class and open attendance'}
          </Button>
        ) : null}
      </div>
      {dialog === 'open' ? (
        <OpenDialog session={session} onClose={() => setDialog(null)} onDone={refresh} />
      ) : null}
      {dialog === 'extend' && a ? (
        <MinutesDialog
          title="Extend attendance"
          description="Give students more time to check in. The reason is recorded."
          path={`/attendance-sessions/${a.id}/extend`}
          defaultMinutes="5"
          submitLabel="Extend"
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      ) : null}
      {dialog === 'reopen' && a ? (
        <MinutesDialog
          title="Reopen attendance"
          description="Attendance can be reopened once, before the scheduled end. Absences already marked can still be raised by a check-in."
          path={`/attendance-sessions/${a.id}/reopen`}
          defaultMinutes="10"
          submitLabel="Reopen"
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      ) : null}
    </section>
  );
}

function OpenDialog(props: {
  session: ClassSessionView;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [minutes, setMinutes] = useState('');
  const starting = props.session.status !== 'ACTIVE';
  return (
    <FormDialog
      open
      title={starting ? 'Start class and open attendance' : 'Open attendance'}
      description={
        starting
          ? 'The class starts now and students can check in with the code you show. Leave the minutes empty to use the university’s setting.'
          : 'Students can check in with the code you show. Leave the minutes empty to use the university’s setting.'
      }
      submitLabel={starting ? 'Start and open' : 'Open'}
      validate={() =>
        minutes.trim() && !/^\d+$/.test(minutes.trim()) ? 'Enter whole minutes, or leave it empty.' : null
      }
      onSubmit={async () => {
        await auth.call(`/class-sessions/${props.session.id}/attendance/open`, {
          method: 'POST',
          body: {
            startClass: true,
            ...(minutes.trim() ? { closeAfterMinutes: Number(minutes.trim()) } : {}),
          },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field
        label="Close after (minutes, optional)"
        name="minutes"
        inputMode="numeric"
        value={minutes}
        onChange={setMinutes}
      />
    </FormDialog>
  );
}

function MinutesDialog(props: {
  title: string;
  description: string;
  path: string;
  defaultMinutes: string;
  submitLabel: string;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [minutes, setMinutes] = useState(props.defaultMinutes);
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      title={props.title}
      description={props.description}
      submitLabel={props.submitLabel}
      validate={() =>
        !/^\d+$/.test(minutes.trim()) || Number(minutes) < 1 || Number(minutes) > 60
          ? 'Enter 1 to 60 minutes.'
          : reason.trim().length < 5
            ? 'Give a reason, at least 5 characters.'
            : null
      }
      onSubmit={async () => {
        await auth.call(props.path, {
          method: 'POST',
          body: { minutes: Number(minutes), reason: reason.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field label="Minutes" name="minutes" inputMode="numeric" value={minutes} onChange={setMinutes} />
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
