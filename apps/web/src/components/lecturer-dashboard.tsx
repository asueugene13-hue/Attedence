'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Alert, LoadingState } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Dashboard {
  waiting: {
    disputes: { count: number; oldestWaitingSince: string | null };
    checkIns: number;
    corrections: { waiting: number; answeredThisWeek: number };
  };
  excusedThisWeek: number;
  minimumPercent: number | null;
  sections: {
    sectionId: string;
    code: string;
    course: { code: string; title: string };
    students: number;
    classesHeld: number;
    percentage: number | null;
  }[];
}

/**
 * The lecturer's dashboard (Phase 6 step 6, as on the design canvas): what waits for them and how each
 * section is doing. Every number is counted by the server from real records.
 */
export function LecturerDashboard() {
  const auth = useAuth();
  const d = useQuery({
    queryKey: ['lecturer-dashboard'],
    queryFn: () => auth.call<Dashboard>('/me/lecturer-dashboard'),
    refetchInterval: 60_000,
  });
  if (d.isPending) return <LoadingState />;
  if (d.isError) return <Alert tone="error">{describeError(d.error)}</Alert>;
  const { waiting, sections, excusedThisWeek, minimumPercent } = d.data;
  const days = waiting.disputes.oldestWaitingSince
    ? Math.floor((Date.now() - Date.parse(waiting.disputes.oldestWaitingSince)) / 86_400_000)
    : null;
  return (
    <div className="stack">
      <section aria-label="Waiting for you" className="tile-grid">
        <Tile
          href="/reviews"
          label="Disputes to decide"
          value={waiting.disputes.count}
          detail={
            waiting.disputes.count === 0
              ? 'None waiting.'
              : `Oldest waits ${days === 0 ? 'under a day' : `${days} day${days === 1 ? '' : 's'}`}. After 3 days it goes to an administrator.`
          }
          attention={waiting.disputes.count > 0}
        />
        <Tile
          href="/today"
          label="Check-ins waiting"
          value={waiting.checkIns}
          detail={waiting.checkIns === 0 ? 'None waiting.' : 'Open the class to approve or reject them.'}
          attention={waiting.checkIns > 0}
        />
        <Tile
          href="/attendance-corrections"
          label="Late corrections waiting"
          value={waiting.corrections.waiting}
          detail={`${waiting.corrections.answeredThisWeek} answered by an administrator this week.`}
        />
        <Tile
          label="Excused this week"
          value={excusedThisWeek}
          detail="Decided by administrators. Reasons stay private."
        />
      </section>
      <section className="card" aria-labelledby="sections-heading">
        <div className="card-header">
          <h2 id="sections-heading">Attendance by section</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Students</th>
                <th scope="col">Classes held</th>
                <th scope="col">Attendance</th>
              </tr>
            </thead>
            <tbody>
              {sections.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    You are not teaching any section right now.
                  </td>
                </tr>
              ) : (
                sections.map((s) => (
                  <tr key={s.sectionId}>
                    <td>
                      {s.course.code} · {s.code}
                      <div className="muted">{s.course.title}</div>
                    </td>
                    <td>{s.students}</td>
                    <td>{s.classesHeld}</td>
                    <td>{s.percentage === null ? '—' : `${s.percentage}%`}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="card-body muted" style={{ margin: 0 }}>
          {minimumPercent === null
            ? 'No minimum attendance set yet, so no student is flagged as below it.'
            : `The minimum is ${minimumPercent}%.`}
        </p>
      </section>
      <p className="muted">
        <Link href="/announcements">Write an announcement</Link>
      </p>
    </div>
  );
}

function Tile(props: { label: string; value: number; detail: string; href?: string; attention?: boolean }) {
  const inner = (
    <>
      <span className="muted" style={{ fontSize: 13 }}>
        {props.label}
      </span>
      <span
        style={{ fontSize: 26, fontWeight: 600, color: props.attention ? 'var(--color-warning)' : undefined }}
      >
        {props.value}
      </span>
      <span className="muted" style={{ fontSize: 12 }}>
        {props.detail}
      </span>
    </>
  );
  return props.href ? (
    <Link href={props.href} className="card tile">
      {inner}
    </Link>
  ) : (
    <div className="card tile">{inner}</div>
  );
}
