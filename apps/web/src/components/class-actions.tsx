'use client';

import {
  ADMIN_ONLY_CANCEL_REASONS,
  CANCEL_REASONS,
  CLASS_ACTIONS,
  type ClassActionName,
  ISSUE_TYPES,
} from '@attendsure/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { CANCEL_REASON_LABELS, type ClassSessionView, type Finding, ISSUE_TYPE_LABELS } from '@/lib/classes';
import { FormDialog } from './form-dialog';
import { SelectField } from './records';
import { Alert, Button, Field } from './ui';

const ADMIN_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN'];
/** Review decisions are made on the review screen, and a reschedule through its own form. */
const HIDDEN: ClassActionName[] = [
  'reschedule',
  'reviewHeld',
  'reviewPostpone',
  'reviewNoAction',
  'reviewNoActionConfirmed',
];
const PATHS: Partial<Record<ClassActionName, string>> = {
  liftHold: 'lift-hold',
  openReview: 'open-review',
  void: 'void',
};
const NEEDS_REASON: ClassActionName[] = ['interrupt', 'suspend', 'liftHold', 'reinstate', 'openReview'];

type Dialog =
  | { kind: 'reason'; action: ClassActionName }
  | { kind: 'delay' }
  | { kind: 'cancel' }
  | { kind: 'void' }
  | { kind: 'report' }
  | { kind: 'reschedule' }
  | null;

/**
 * The buttons a person may use on one class, from the shared transition table. The API checks every
 * request again; this only avoids showing buttons that would be refused.
 */
export function ClassActions({
  session,
  onChanged,
}: {
  session: ClassSessionView;
  onChanged: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const me = auth.me!;
  const isOwnLecturer = me.activeRole === 'LECTURER' && session.lecturer?.userId === me.user.id;
  const isAdmin = ADMIN_ROLES.includes(me.activeRole);
  const isStudent = me.activeRole === 'STUDENT' || me.activeRole === 'COURSE_REP';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const allowed = (Object.keys(CLASS_ACTIONS) as ClassActionName[]).filter((name) => {
    if (HIDDEN.includes(name)) return false;
    const def = CLASS_ACTIONS[name] as {
      lecturerFrom: readonly string[];
      adminFrom: readonly string[];
      lecturerPermission?: string;
      adminPermission?: string;
    };
    if (isOwnLecturer && def.lecturerFrom.includes(session.status)) {
      return !def.lecturerPermission || auth.can(def.lecturerPermission);
    }
    if (isAdmin && def.adminFrom.includes(session.status))
      return !def.adminPermission || auth.can(def.adminPermission);
    return false;
  });
  const notStarted = [
    'SCHEDULED',
    'CONFIRMED',
    'POSTPONED',
    'UNCONFIRMED',
    'UNDER_REVIEW',
    'SUSPENDED',
  ].includes(session.status);
  const canReschedule =
    notStarted &&
    ((isOwnLecturer && auth.can('class_sessions.request_reschedule')) ||
      (isAdmin && auth.can('class_sessions.reschedule')));
  const canReport =
    (isOwnLecturer || isStudent) &&
    auth.can('class_issues.report') &&
    !['COMPLETED', 'CANCELLED', 'RESCHEDULED'].includes(session.status);

  async function run(action: ClassActionName, body: object = {}) {
    await auth.call(`/class-sessions/${session.id}/${PATHS[action] ?? action}`, { method: 'POST', body });
    setNotice(`${CLASS_ACTIONS[action].label}: done.`);
    await onChanged();
  }

  function open(action: ClassActionName) {
    setNotice(null);
    if (action === 'delay') setDialog({ kind: 'delay' });
    else if (action === 'cancel') setDialog({ kind: 'cancel' });
    else if (action === 'void') setDialog({ kind: 'void' });
    else if (NEEDS_REASON.includes(action)) setDialog({ kind: 'reason', action });
    else
      void run(action).catch((e: unknown) =>
        setNotice(e instanceof Error ? e.message : 'Something went wrong.'),
      );
  }

  if (allowed.length === 0 && !canReschedule && !canReport) return null;

  return (
    <div className="stack-sm">
      <div className="row" role="group" aria-label="Class actions">
        {allowed.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={
              name === 'cancel' || name === 'void' ? 'danger' : name === 'start' ? 'primary' : 'secondary'
            }
            onClick={() => open(name)}
          >
            {CLASS_ACTIONS[name].label}
          </Button>
        ))}
        {canReschedule ? (
          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'reschedule' })}>
            {isAdmin ? 'Reschedule' : 'Ask to reschedule'}
          </Button>
        ) : null}
        {canReport ? (
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'report' })}>
            Report a problem
          </Button>
        ) : null}
      </div>
      {notice ? <Alert tone="info">{notice}</Alert> : null}

      {dialog?.kind === 'reason' ? (
        <ReasonOnly
          action={dialog.action}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => run(dialog.action, { reason })}
        />
      ) : null}
      {dialog?.kind === 'delay' ? (
        <DelayDialog onClose={() => setDialog(null)} onSubmit={(b) => run('delay', b)} />
      ) : null}
      {dialog?.kind === 'cancel' ? (
        <CancelDialog asAdmin={isAdmin} onClose={() => setDialog(null)} onSubmit={(b) => run('cancel', b)} />
      ) : null}
      {dialog?.kind === 'void' ? (
        <VoidDialog onClose={() => setDialog(null)} onSubmit={(b) => run('void', b)} />
      ) : null}
      {dialog?.kind === 'report' ? (
        <ReportDialog
          sessionId={session.id}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setNotice('Thank you. Your report was recorded and the class will be checked.');
            await onChanged();
          }}
        />
      ) : null}
      {dialog?.kind === 'reschedule' ? (
        <RescheduleDialog
          session={session}
          direct={isAdmin}
          onClose={() => setDialog(null)}
          onDone={async (message) => {
            setNotice(message);
            await onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function ReasonOnly(props: {
  action: ClassActionName;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      title={CLASS_ACTIONS[props.action].label}
      submitLabel={CLASS_ACTIONS[props.action].label}
      validate={() => (reason.trim().length < 5 ? 'Explain briefly, at least 5 characters.' : null)}
      onSubmit={() => props.onSubmit(reason.trim())}
      onClose={props.onClose}
    >
      <Field
        label="Reason (recorded)"
        name="reason"
        multiline
        required
        value={reason}
        onChange={setReason}
        maxLength={500}
      />
    </FormDialog>
  );
}

function DelayDialog(props: { onClose: () => void; onSubmit: (body: object) => Promise<void> }) {
  const [minutes, setMinutes] = useState('15');
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      title="Report a delay"
      description="Students are told the new start time. The class must still leave 30 minutes before its scheduled end."
      submitLabel="Report delay"
      validate={() =>
        !/^\d+$/.test(minutes) || Number(minutes) < 5 || Number(minutes) > 240
          ? 'The delay is 5 to 240 minutes.'
          : reason.trim().length < 5
            ? 'Explain briefly, at least 5 characters.'
            : null
      }
      onSubmit={() => props.onSubmit({ minutes: Number(minutes), reason: reason.trim() })}
      onClose={props.onClose}
    >
      <Field
        label="Minutes after the scheduled start"
        name="minutes"
        inputMode="numeric"
        value={minutes}
        onChange={setMinutes}
      />
      <Field label="Reason" name="reason" multiline value={reason} onChange={setReason} maxLength={500} />
    </FormDialog>
  );
}

function CancelDialog(props: {
  asAdmin: boolean;
  onClose: () => void;
  onSubmit: (body: object) => Promise<void>;
}) {
  const reasons = CANCEL_REASONS.filter(
    (r) => props.asAdmin || !(ADMIN_ONLY_CANCEL_REASONS as readonly string[]).includes(r),
  );
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      destructive
      title="Cancel class"
      description="Students and the course rep are told at once, in the app and by email."
      submitLabel="Cancel class"
      validate={() =>
        !reasonCode
          ? 'Choose a reason.'
          : reasonCode === 'OTHER' && note.trim().length < 5
            ? 'Explain the reason, at least 5 characters.'
            : null
      }
      onSubmit={() => props.onSubmit({ reasonCode, ...(note.trim() ? { note: note.trim() } : {}) })}
      onClose={props.onClose}
    >
      <SelectField
        label="Reason"
        name="reasonCode"
        value={reasonCode}
        onChange={setReasonCode}
        placeholder="Choose a reason"
        options={reasons.map((r) => ({ value: r, label: CANCEL_REASON_LABELS[r] }))}
      />
      <Field
        label="Note (needed for “Other”)"
        name="note"
        multiline
        value={note}
        onChange={setNote}
        maxLength={500}
      />
    </FormDialog>
  );
}

function VoidDialog(props: { onClose: () => void; onSubmit: (body: object) => Promise<void> }) {
  const [reasonCode, setReasonCode] = useState('OTHER');
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      destructive
      title="Void class"
      description="Cancels a class that had started. Nothing is deleted; the history keeps everything."
      submitLabel="Void class"
      validate={() => (reason.trim().length < 5 ? 'Explain briefly, at least 5 characters.' : null)}
      onSubmit={() => props.onSubmit({ reasonCode, reason: reason.trim() })}
      onClose={props.onClose}
    >
      <SelectField
        label="Reason"
        name="reasonCode"
        value={reasonCode}
        onChange={setReasonCode}
        options={CANCEL_REASONS.map((r) => ({ value: r, label: CANCEL_REASON_LABELS[r] }))}
      />
      <Field
        label="Explanation (recorded)"
        name="reason"
        multiline
        value={reason}
        onChange={setReason}
        maxLength={500}
      />
    </FormDialog>
  );
}

function ReportDialog(props: { sessionId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const auth = useAuth();
  const [type, setType] = useState('');
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      title="Report a problem with this class"
      description="Your report helps the university check on the class. It never cancels a class by itself."
      submitLabel="Send report"
      validate={() => (!type ? 'Choose what is wrong.' : null)}
      onSubmit={async () => {
        await auth.call(`/class-sessions/${props.sessionId}/issue-reports`, {
          method: 'POST',
          body: { type, ...(note.trim() ? { note: note.trim() } : {}) },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <SelectField
        label="What is wrong?"
        name="type"
        value={type}
        onChange={setType}
        placeholder="Choose one"
        options={ISSUE_TYPES.map((t) => ({ value: t, label: ISSUE_TYPE_LABELS[t] }))}
      />
      <Field label="Note (optional)" name="note" multiline value={note} onChange={setNote} maxLength={500} />
    </FormDialog>
  );
}

interface Room {
  id: string;
  code: string;
  name: string;
  building: { name: string };
}

/** A lecturer asks to move the class (an administrator approves); an administrator moves it directly. */
export function RescheduleDialog(props: {
  session: ClassSessionView;
  direct: boolean;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const auth = useAuth();
  const rooms = useQuery({ queryKey: ['classrooms'], queryFn: () => auth.call<Room[]>('/classrooms') });
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [classroomId, setClassroomId] = useState(props.session.classroom?.id ?? '');
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState<{ blockers: Finding[]; warnings: Finding[] } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const proposal = { date, startTime, endTime, classroomId };
  const incomplete = !date || !/^\d\d:\d\d$/.test(startTime) || !/^\d\d:\d\d$/.test(endTime) || !classroomId;

  async function runCheck() {
    setCheckError(null);
    try {
      setCheck(
        await auth.call<{ blockers: Finding[]; warnings: Finding[] }>(
          `/class-sessions/${props.session.id}/reschedule-check`,
          {
            method: 'POST',
            body: proposal,
          },
        ),
      );
    } catch (e) {
      setCheck(null);
      setCheckError(e instanceof Error ? e.message : 'The check could not run.');
    }
  }

  return (
    <FormDialog
      open
      title={props.direct ? 'Reschedule class' : 'Ask to reschedule'}
      description={
        props.direct
          ? 'For exceptional cases: the class moves at once. A reason is required and recorded.'
          : 'An administrator approves or rejects your request after seeing the conflict check.'
      }
      submitLabel={props.direct ? 'Reschedule now' : 'Send request'}
      validate={() =>
        incomplete
          ? 'Fill in the date, both times (HH:MM) and the room.'
          : reason.trim().length < 5
            ? 'Explain briefly, at least 5 characters.'
            : null
      }
      onSubmit={async () => {
        const path = props.direct ? 'reschedule' : 'reschedule-requests';
        await auth.call(`/class-sessions/${props.session.id}/${path}`, {
          method: 'POST',
          body: { ...proposal, reason: reason.trim() },
        });
        await props.onDone(
          props.direct ? 'The class was rescheduled.' : 'Your request was sent for approval.',
        );
      }}
      onClose={props.onClose}
    >
      <div className="row">
        <Field label="New date" name="date" type="date" value={date} onChange={setDate} />
        <Field
          label="Starts (HH:MM)"
          name="startTime"
          type="time"
          value={startTime}
          onChange={setStartTime}
        />
        <Field label="Ends (HH:MM)" name="endTime" type="time" value={endTime} onChange={setEndTime} />
      </div>
      <SelectField
        label="Room"
        name="classroomId"
        value={classroomId}
        onChange={setClassroomId}
        placeholder={rooms.isPending ? 'Loading…' : 'Choose a room'}
        options={(rooms.data ?? []).map((r) => ({
          value: r.id,
          label: `${r.code} · ${r.name} (${r.building.name})`,
        }))}
      />
      <Field label="Reason" name="reason" multiline value={reason} onChange={setReason} maxLength={500} />
      <div className="row">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={incomplete}
          onClick={() => void runCheck()}
        >
          Check for conflicts
        </Button>
      </div>
      {checkError ? <Alert tone="error">{checkError}</Alert> : null}
      {check ? (
        check.blockers.length === 0 && check.warnings.length === 0 ? (
          <Alert tone="success">No conflicts found.</Alert>
        ) : (
          <>
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
        )
      ) : null}
    </FormDialog>
  );
}
