'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ClassActions } from '@/components/class-actions';
import { ClassTable } from '@/components/class-list';
import { StatusBadge } from '@/components/records';
import { Alert, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  addDays,
  type ClassSessionView,
  classLabel,
  classTime,
  STATUS_DISPLAY,
  todayInAccra,
} from '@/lib/classes';

/** The lecturer's classes today, each with the buttons they need, and the week ahead. */
export default function TodayPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const today = todayInAccra();
  const mine = useQuery({
    queryKey: ['my-timetable', today],
    queryFn: () =>
      auth.call<{ as: string; data: ClassSessionView[] }>(
        `/me/timetable?from=${today}&to=${addDays(today, 7)}`,
      ),
    refetchInterval: 30_000,
  });
  if (mine.isPending) return <LoadingState />;
  if (mine.isError) return <Alert tone="error">{describeError(mine.error)}</Alert>;
  const todays = mine.data.data.filter((s) => todayInAccra(new Date(s.scheduledStart)) === today);
  const later = mine.data.data.filter((s) => todayInAccra(new Date(s.scheduledStart)) !== today);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['my-timetable'] });

  return (
    <div className="stack">
      <PageHeader
        title="Today"
        subtitle="Your classes today. Confirm, start, report a delay or cancel here; students are told at once."
      />
      {mine.data.as === 'NONE' ? <Alert tone="info">You have no classes to teach or attend.</Alert> : null}
      {todays.length === 0 && mine.data.as !== 'NONE' ? <p className="muted">No classes today.</p> : null}
      {todays.map((s) => (
        <section key={s.id} className="card" aria-label={classLabel(s)}>
          <div className="card-header">
            <h2>
              <Link href={`/classes/${s.id}`}>{classLabel(s)}</Link>
            </h2>
            <StatusBadge tone={STATUS_DISPLAY[s.status].tone} label={STATUS_DISPLAY[s.status].label} />
          </div>
          <div className="card-body stack-sm">
            <p>
              {classTime(s)} ·{' '}
              {s.classroom ? `${s.classroom.code} · ${s.classroom.name}` : 'room to be confirmed'}
            </p>
            {s.status === 'UNCONFIRMED' || s.status === 'UNDER_REVIEW' ? (
              <Alert tone="warning">
                This class has not started. What is happening? Please choose an action.
              </Alert>
            ) : null}
            <ClassActions session={s} onChanged={refresh} />
          </div>
        </section>
      ))}
      <h2>The next 7 days</h2>
      <ClassTable sessions={later} empty="Nothing else in the next 7 days." />
    </div>
  );
}
