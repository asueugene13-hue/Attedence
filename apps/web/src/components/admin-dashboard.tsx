'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Alert, LoadingState } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface AdminDashboardData {
  today: { date: string; classes: Record<string, number> };
  lastSevenDays: {
    present: number;
    late: number;
    absences: number;
    excused: number;
    undecided: number;
    percentage: number | null;
  };
  waiting: {
    classReviews: { count: number; priority: number } | null;
    disputes: number | null;
    excuses: number | null;
    lateCorrections: number | null;
    riskFlags: number | null;
    phoneApprovals: number | null;
  };
  beaconsSuspectedFaulty: number | null;
  unacknowledgedSystemEvents: number | null;
}

const STATUS_LABELS: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  POSTPONED: 'Delayed',
  UNCONFIRMED: 'Not confirmed',
  UNDER_REVIEW: 'Under review',
  ACTIVE: 'In progress',
  INTERRUPTED: 'Interrupted',
  COMPLETED: 'Held',
  CANCELLED: 'Cancelled',
  RESCHEDULED: 'Moved',
  SUSPENDED: 'Suspended',
};

/**
 * The administrator's dashboard (Phase 7 step 3): today's classes, the last 7 days' attendance and what
 * waits, all from the server within the administrator's scope. Items the role cannot act on are not shown.
 */
export function AdminDashboard() {
  const auth = useAuth();
  const d = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn: () => auth.call<AdminDashboardData>('/me/admin-dashboard'),
    refetchInterval: 60_000,
  });
  if (d.isPending) return <LoadingState />;
  if (d.isError) return <Alert tone="error">{describeError(d.error)}</Alert>;
  const { today, lastSevenDays: week, waiting } = d.data;
  const todayTotal = Object.values(today.classes).reduce((a, b) => a + b, 0);
  const tiles: { label: string; value: number; href: string; detail?: string }[] = [];
  const add = (label: string, value: number | null, href: string, detail?: string) => {
    if (value !== null) tiles.push({ label, value, href, detail });
  };
  add(
    'Classes to review',
    waiting.classReviews?.count ?? null,
    '/class-reviews',
    waiting.classReviews?.priority ? `${waiting.classReviews.priority} priority` : undefined,
  );
  add('Disputes waiting', waiting.disputes, '/reviews');
  add('Excuse requests', waiting.excuses, '/reviews?tab=excuses');
  add('Late corrections', waiting.lateCorrections, '/attendance-corrections');
  add('Risk flags', waiting.riskFlags, '/risk-flags');
  add('Phones to approve', waiting.phoneApprovals, '/devices');
  add('Beacons suspected faulty', d.data.beaconsSuspectedFaulty, '/beacons');
  add('System problems', d.data.unacknowledgedSystemEvents, '/admin/system-health');
  return (
    <div className="stack">
      <section className="tile-grid" aria-label="Today and this week">
        <div className="card tile">
          <span className="muted" style={{ fontSize: 13 }}>
            Today’s classes
          </span>
          <span style={{ fontSize: 26, fontWeight: 600 }}>{todayTotal}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {todayTotal === 0
              ? 'No classes today.'
              : Object.entries(today.classes)
                  .map(([status, n]) => `${n} ${(STATUS_LABELS[status] ?? status).toLowerCase()}`)
                  .join(' · ')}
          </span>
        </div>
        <div className="card tile">
          <span className="muted" style={{ fontSize: 13 }}>
            Attendance, last 7 days
          </span>
          <span style={{ fontSize: 26, fontWeight: 600 }}>
            {week.percentage === null ? '—' : `${week.percentage}%`}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {week.present + week.late + week.absences === 0
              ? 'Nothing counted yet.'
              : `${week.present} present · ${week.late} late · ${week.absences} absences${week.excused ? ` · ${week.excused} excused` : ''}`}
          </span>
        </div>
      </section>
      <section aria-labelledby="waiting-heading" className="stack-sm">
        <h2 id="waiting-heading" style={{ margin: 0, fontSize: 16 }}>
          Waiting for a decision
        </h2>
        <div className="tile-grid">
          {tiles.map((t) => (
            <Link key={t.label} href={t.href} className="card tile">
              <span className="muted" style={{ fontSize: 13 }}>
                {t.label}
              </span>
              <span
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  color: t.value > 0 ? 'var(--color-warning)' : undefined,
                }}
              >
                {t.value}
              </span>
              {t.detail ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  {t.detail}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </section>
      <p className="muted" style={{ margin: 0 }}>
        <Link href="/reports">Reports and analytics</Link>
      </p>
    </div>
  );
}
