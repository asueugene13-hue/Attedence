'use client';

import { CANCEL_REASONS } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  CANCEL_REASON_LABELS,
  classLabel,
  classTime,
  EVENT_LABELS,
  ISSUE_TYPE_LABELS,
  REVIEW_DECISION_LABELS,
  type ReviewView,
  refreshClassData,
  STATUS_DISPLAY,
} from '@/lib/classes';
import { formatDateTime } from '@/lib/format';

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <PermissionGate permission="class_reviews.decide">
      <Review id={id} />
    </PermissionGate>
  );
}

const STARTED = ['ACTIVE', 'INTERRUPTED', 'COMPLETED'];

function Review({ id }: { id: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: ['class-review', id],
    queryFn: () => auth.call<ReviewView>(`/class-reviews/${id}`),
  });
  const [deciding, setDeciding] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const refresh = () => refreshClassData(queryClient);

  if (review.isPending) return <LoadingState />;
  if (review.isError) return <Alert tone="error">{describeError(review.error)}</Alert>;
  const r = review.data;
  const s = r.classSession!;
  const status = STATUS_DISPLAY[s.status];

  return (
    <div className="stack">
      <PageHeader
        title={`Review: ${classLabel(s)}`}
        subtitle={classTime(s)}
        actions={r.status === 'OPEN' ? <Button onClick={() => setDeciding(true)}>Decide</Button> : null}
      />
      <section className="card">
        <div className="card-body stack-sm">
          <div className="row">
            {r.isPriority ? <StatusBadge tone="error" label="Priority" /> : null}
            <StatusBadge tone={status.tone} label={`Class: ${status.label}`} />
            <span className="muted">
              Opened {formatDateTime(r.openedAt)} by{' '}
              {r.trigger === 'SYSTEM_ESCALATION' ? 'the system' : 'an administrator'}
            </span>
          </div>
          <p>{r.reasons.join(' ')}</p>
          {r.status === 'DECIDED' ? (
            <Alert tone="success">
              Decided: {REVIEW_DECISION_LABELS[r.decision ?? ''] ?? r.decision} ({formatDateTime(r.decidedAt)}
              ). {r.decisionNote}
            </Alert>
          ) : null}
          {r.status === 'OPEN' && STARTED.includes(s.status) ? (
            <Alert tone="info">
              The lecturer started this class after the review opened. Decide “held” to close the review.
            </Alert>
          ) : null}
          <p>
            <Link href={`/classes/${s.id}`}>Open the class page</Link>
          </p>
        </div>
      </section>

      <section className="card" aria-labelledby="review-reports">
        <div className="card-header">
          <h2 id="review-reports">Reports</h2>
        </div>
        <div className="card-body">
          {(r.reports ?? []).length === 0 ? <p className="muted">No reports.</p> : null}
          <ul className="stack-sm">
            {(r.reports ?? []).map((rep) => (
              <li key={rep.id} className="row">
                <span>
                  <strong>{ISSUE_TYPE_LABELS[rep.type]}</strong>{' '}
                  <span className="muted">
                    · {rep.reporterRole === 'COURSE_REP' ? 'course rep' : rep.reporterRole.toLowerCase()} ·{' '}
                    {formatDateTime(rep.createdAt)}
                  </span>
                  {rep.note ? <span> — {rep.note}</span> : null}
                </span>
                <span className="spacer" />
                {rep.status === 'DISMISSED' ? (
                  <StatusBadge tone="neutral" label="Dismissed" />
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setDismissing(rep.id)}>
                    Dismiss
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="card" aria-labelledby="review-timeline">
        <div className="card-header">
          <h2 id="review-timeline">Timeline</h2>
        </div>
        <div className="card-body">
          <ol className="stack-sm">
            {(s.events ?? []).map((e) => (
              <li key={e.id}>
                <strong>{EVENT_LABELS[e.type] ?? e.type}</strong>{' '}
                <span className="muted">· {formatDateTime(e.occurredAt)}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {deciding ? <DecideDialog review={r} onClose={() => setDeciding(false)} onDone={refresh} /> : null}
      {dismissing ? (
        <DismissDialog reportId={dismissing} onClose={() => setDismissing(null)} onDone={refresh} />
      ) : null}
    </div>
  );
}

function DecideDialog(props: { review: ReviewView; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const started = STARTED.includes(props.review.classSession!.status);
  const choices = started
    ? ['CLASS_HELD']
    : ['CLASS_HELD', 'CANCELLED', 'POSTPONED', 'RESCHEDULED', 'NO_ACTION'];
  const [decision, setDecision] = useState(choices[0]!);
  const [note, setNote] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [minutes, setMinutes] = useState('30');
  const rooms = useQuery({
    queryKey: ['classrooms'],
    queryFn: () => auth.call<{ id: string; code: string; name: string }[]>('/classrooms'),
    enabled: decision === 'RESCHEDULED',
  });
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [classroomId, setClassroomId] = useState(props.review.classSession!.classroom?.id ?? '');

  return (
    <FormDialog
      open
      title="Decide this review"
      description="Every decision needs a note. Students and the lecturer are told the result."
      submitLabel="Record decision"
      destructive={decision === 'CANCELLED'}
      validate={() => {
        if (note.trim().length < 5) return 'Write a note, at least 5 characters.';
        if (decision === 'CANCELLED' && !reasonCode) return 'Choose a cancellation reason.';
        if (decision === 'POSTPONED' && !/^\d+$/.test(minutes)) return 'Give the delay in minutes.';
        if (decision === 'RESCHEDULED' && (!date || !startTime || !endTime || !classroomId))
          return 'Fill in the new date, times and room.';
        return null;
      }}
      onSubmit={async () => {
        const body: Record<string, unknown> = { decision, note: note.trim() };
        if (decision === 'CANCELLED') body.reasonCode = reasonCode;
        if (decision === 'POSTPONED') body.minutes = Number(minutes);
        if (decision === 'RESCHEDULED') body.reschedule = { date, startTime, endTime, classroomId };
        await auth.call(`/class-reviews/${props.review.id}/decide`, { method: 'POST', body });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <SelectField
        label="Decision"
        name="decision"
        value={decision}
        onChange={setDecision}
        options={choices.map((c) => ({ value: c, label: REVIEW_DECISION_LABELS[c]! }))}
        hint={decision === 'NO_ACTION' ? 'Only possible until 15 minutes after the start.' : undefined}
      />
      {decision === 'CANCELLED' ? (
        <SelectField
          label="Cancellation reason"
          name="reasonCode"
          value={reasonCode}
          onChange={setReasonCode}
          placeholder="Choose a reason"
          options={CANCEL_REASONS.map((c) => ({ value: c, label: CANCEL_REASON_LABELS[c] }))}
        />
      ) : null}
      {decision === 'POSTPONED' ? (
        <Field
          label="New start: minutes after the scheduled start"
          name="minutes"
          inputMode="numeric"
          value={minutes}
          onChange={setMinutes}
        />
      ) : null}
      {decision === 'RESCHEDULED' ? (
        <>
          <div className="row">
            <Field label="New date" name="date" type="date" value={date} onChange={setDate} />
            <Field label="Starts" name="startTime" type="time" value={startTime} onChange={setStartTime} />
            <Field label="Ends" name="endTime" type="time" value={endTime} onChange={setEndTime} />
          </div>
          <SelectField
            label="Room"
            name="classroomId"
            value={classroomId}
            onChange={setClassroomId}
            placeholder="Choose a room"
            options={(rooms.data ?? []).map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }))}
          />
        </>
      ) : null}
      <Field label="Note (recorded)" name="note" multiline value={note} onChange={setNote} maxLength={500} />
    </FormDialog>
  );
}

function DismissDialog(props: { reportId: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const [note, setNote] = useState('');
  return (
    <FormDialog
      open
      title="Dismiss this report"
      description="The report stays on record but no longer counts as evidence."
      submitLabel="Dismiss report"
      validate={() => (note.trim().length < 5 ? 'Explain why, at least 5 characters.' : null)}
      onSubmit={async () => {
        await auth.call(`/class-issue-reports/${props.reportId}/dismiss`, {
          method: 'POST',
          body: { note: note.trim() },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field label="Why (recorded)" name="note" multiline value={note} onChange={setNote} maxLength={500} />
    </FormDialog>
  );
}
