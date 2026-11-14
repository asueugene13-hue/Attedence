'use client';

import Link from 'next/link';
import { LecturerDashboard } from '@/components/lecturer-dashboard';
import { Alert, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { roleLabel } from '@/lib/format';
import { MOBILE_FIRST_ROLES, visibleNavItems } from '@/lib/navigation';

export default function HomePage() {
  const { me } = useAuth();
  if (!me) return null;
  const tools = visibleNavItems(me.permissions).filter((item) => item.href !== '/');

  return (
    <div className="stack">
      <PageHeader
        title={`Welcome, ${me.user.fullName}`}
        subtitle={`Signed in as ${roleLabel(me.activeRole)}.`}
      />

      {MOBILE_FIRST_ROLES.includes(me.activeRole) ? (
        <Alert tone="info">
          Students and course representatives use the AttendSure mobile app to check in and follow their
          timetable, see their attendance, send disputes and excuse requests, and show their student ID.
        </Alert>
      ) : null}

      {me.activeRole === 'LECTURER' ? <LecturerDashboard /> : null}

      {me.activeRole !== 'LECTURER' && tools.length > 0 ? (
        <section className="card" aria-labelledby="tools-heading">
          <div className="card-header">
            <h2 id="tools-heading">Your tools</h2>
          </div>
          <ul className="card-body stack-sm" style={{ margin: 0, listStyle: 'none' }}>
            {tools.map((item) => (
              <li key={item.href}>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="muted">
        AttendSure is being built in phases. Reports and administration dashboards come next.
      </p>
    </div>
  );
}
