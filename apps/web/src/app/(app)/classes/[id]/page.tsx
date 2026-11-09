'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';
import { ClassActions } from '@/components/class-actions';
import { StatusBadge } from '@/components/records';
import { Alert, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  CANCEL_REASON_LABELS,
  type ClassEventView,
  type ClassSessionView,
  classLabel,
  classTime,
  EVENT_LABELS,
  ISSUE_TYPE_LABELS,
  type IssueReportView,
  STATUS_DISPLAY,
} from '@/lib/classes';
import { formatDateTime } from '@/lib/format';

/** One class: what it is, its status, everything that happened to it, its reports, and what you may do. */
export default function ClassPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['class-session', id],
    queryFn: () => auth.call<ClassSessionView & { events: ClassEventView[] }>(`/class-sessions/${id}`),
    refetchInterval: 30_000,
  });
  const reports = useQuery({
    queryKey: ['class-session', id, 'reports'],
    queryFn: () => auth.call<{ data: IssueReportView[] }>(`/class-sessions/${id}/issue-reports`),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['class-session', id] }),
      queryClient.invalidateQueries({ queryKey: ['class-sessions'] }),
      queryClient.invalidateQueries({ queryKey: ['my-timetable'] }),
    ]);

  if (session.isPending) return <LoadingState />;
  if (session.isError) return <Alert tone="error">{describeError(session.error)}</Alert>;
  const s = session.data;
  const display = STATUS_DISPLAY[s.status];
  const replacement = s.events.find((e) => e.type === 'RESCHEDULED')?.payload?.replacementSessionId;

  return (
    <div className="stack">
      <PageHeader title={classLabel(s)} subtitle={s.sections.map((x) => x.course.title).join(' · ')} />
      <section className="card" aria-labelledby="class-summary">
        <div className="card-header">
          <h2 id="class-summary">{classTime(s)}</h2>
          <StatusBadge tone={display.tone} label={display.label} />
        </div>
        <div className="card-body stack">
          <dl className="details">
            <dt>Lecturer</dt>
            <dd>{s.lecturer?.fullName ?? '—'}</dd>
            <dt>Room</dt>
            <dd>{s.classroom ? `${s.classroom.code} · ${s.classroom.name}` : '—'}</dd>
            {s.cancelReason ? (
              <>
                <dt>Cancellation</dt>
                <dd>
                  {CANCEL_REASON_LABELS[s.cancelReason]}
                  {s.cancelNote ? ` — ${s.cancelNote}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
          {s.rescheduledFromId ? (
            <p>
              This class replaces <Link href={`/classes/${s.rescheduledFromId}`}>the original class</Link>.
            </p>
          ) : null}
          {typeof replacement === 'string' ? (
            <p>
              This class was moved: <Link href={`/classes/${replacement}`}>see the replacement class</Link>.
            </p>
          ) : null}
          {s.status === 'UNDER_REVIEW' ? (
            <Alert tone="warning">
              The university is checking on this class. An administrator will decide.
            </Alert>
          ) : null}
          <ClassActions session={s} onChanged={refresh} />
        </div>
      </section>

      <section className="card" aria-labelledby="class-reports">
        <div className="card-header">
          <h2 id="class-reports">Reported problems</h2>
        </div>
        <div className="card-body">
          {reports.isError ? <Alert tone="error">{describeError(reports.error)}</Alert> : null}
          {reports.data && reports.data.data.length === 0 ? (
            <p className="muted">No problems reported.</p>
          ) : null}
          {reports.data && reports.data.data.length > 0 ? (
            <ul className="stack-sm">
              {reports.data.data.map((r) => (
                <li key={r.id}>
                  <strong>{ISSUE_TYPE_LABELS[r.type]}</strong>{' '}
                  <span className="muted">
                    · {r.reporterRole === 'COURSE_REP' ? 'course rep' : r.reporterRole.toLowerCase()} ·{' '}
                    {formatDateTime(r.createdAt)}
                    {r.status === 'DISMISSED' ? ' · dismissed' : ''}
                  </span>
                  {r.note ? <div>{r.note}</div> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="card" aria-labelledby="class-history">
        <div className="card-header">
          <h2 id="class-history">History</h2>
        </div>
        <div className="card-body">
          <ol className="stack-sm">
            {s.events.map((e) => (
              <li key={e.id}>
                <strong>{EVENT_LABELS[e.type] ?? e.type}</strong>{' '}
                <span className="muted">
                  · {formatDateTime(e.occurredAt)} ·{' '}
                  {e.actorType === 'SYSTEM' ? 'by the system' : 'by a person'}
                </span>
                {describePayload(e)}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

function describePayload(e: ClassEventView) {
  const p = e.payload ?? {};
  const parts: string[] = [];
  if (typeof p.reason === 'string') parts.push(p.reason);
  if (typeof p.note === 'string') parts.push(p.note);
  if (Array.isArray(p.reasons)) parts.push(p.reasons.join(' '));
  if (typeof p.minutes === 'number') parts.push(`${p.minutes} minutes`);
  return parts.length ? <div className="secondary-text">{parts.join(' · ')}</div> : null;
}
