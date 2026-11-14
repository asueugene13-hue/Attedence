'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface JobOverview {
  checkedAt: string;
  lastDay: Record<string, number>;
  recentFailures: {
    queue: string;
    name: string;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
  }[];
  schedules: { job: string; everyMinutes: number; lastSucceededAt: string | null; overdue: boolean }[];
  queues: Record<string, Record<string, number> | null>;
  outboxWaiting: number;
}

interface SystemEvent {
  id: string;
  type: string;
  severity: string;
  source: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: { fullName: string } | null;
}

export default function SystemHealthPage() {
  return (
    <PermissionGate permission="system_health.read">
      <SystemHealth />
    </PermissionGate>
  );
}

/** Problems the system raised for staff, such as a background job that failed every retry. */
function SystemHealth() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const events = useQuery({
    queryKey: ['system-events', all],
    queryFn: () => auth.call<{ data: SystemEvent[] }>(`/system-events?limit=100&unacknowledged=${!all}`),
    refetchInterval: 60_000,
  });

  async function acknowledge(id: string) {
    setError(null);
    try {
      await auth.call(`/system-events/${id}/acknowledge`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['system-events'] });
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="System health"
        subtitle="Problems the system could not fix by itself. Acknowledge one once someone is dealing with it."
      />
      <JobsPanel />
      <h2 style={{ margin: 0, fontSize: 16 }}>Problems</h2>
      <label className="checkbox">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include
        acknowledged
      </label>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {events.isPending ? <LoadingState /> : null}
      {events.isError ? <Alert tone="error">{describeError(events.error)}</Alert> : null}
      {events.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Severity</th>
                <th scope="col">Where</th>
                <th scope="col">What happened</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {events.data.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {all ? 'No problems recorded.' : 'Nothing needs attention.'}
                  </td>
                </tr>
              ) : (
                events.data.data.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDateTime(e.createdAt)}</td>
                    <td>
                      <StatusBadge
                        tone={e.severity === 'HIGH' || e.severity === 'CRITICAL' ? 'error' : 'warning'}
                        label={e.severity}
                      />
                    </td>
                    <td>{e.source}</td>
                    <td>{e.message}</td>
                    <td>
                      {e.acknowledgedAt ? (
                        <span className="muted">
                          Acknowledged {formatDateTime(e.acknowledgedAt)} · {e.acknowledgedBy?.fullName}
                        </span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => void acknowledge(e.id)}>
                          Acknowledge
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Background jobs (Phase 7 step 4): if schedules are overdue, the worker is probably not running and
 * attendance will not close on its own, so this is shown first.
 */
function JobsPanel() {
  const auth = useAuth();
  const jobs = useQuery({
    queryKey: ['system-jobs'],
    queryFn: () => auth.call<JobOverview>('/system/jobs'),
    refetchInterval: 60_000,
  });
  if (jobs.isPending) return <LoadingState />;
  if (jobs.isError) return <Alert tone="error">{describeError(jobs.error)}</Alert>;
  const j = jobs.data;
  const overdue = j.schedules.filter((s) => s.overdue);
  return (
    <section className="card" aria-labelledby="jobs-heading">
      <div className="card-header">
        <h2 id="jobs-heading">Background jobs</h2>
        <div className="muted">Checked {formatDateTime(j.checkedAt)}</div>
      </div>
      <div className="card-body stack">
        {overdue.length > 0 ? (
          <Alert tone="error">
            {overdue.length} scheduled job{overdue.length === 1 ? ' has' : 's have'} not run for a while. The
            worker may be stopped: attendance will not close on its own and reminders will not go out until it
            runs.
          </Alert>
        ) : (
          <Alert tone="success">Every scheduled job has run recently.</Alert>
        )}
        <p className="muted" style={{ margin: 0 }}>
          Last 24 hours:{' '}
          {Object.keys(j.lastDay).length === 0
            ? 'no jobs ran.'
            : Object.entries(j.lastDay)
                .map(([status, n]) => `${n} ${status.toLowerCase()}`)
                .join(' · ')}{' '}
          · {j.outboxWaiting} waiting to be queued
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Scheduled job</th>
                <th scope="col">Every</th>
                <th scope="col">Last succeeded</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {j.schedules.map((s) => (
                <tr key={s.job}>
                  <td>
                    <code>{s.job}</code>
                  </td>
                  <td>{s.everyMinutes} min</td>
                  <td>{s.lastSucceededAt ? formatDateTime(s.lastSucceededAt) : 'Never'}</td>
                  <td>
                    <StatusBadge
                      tone={s.overdue ? 'error' : 'success'}
                      label={s.overdue ? 'Overdue' : 'Running'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {j.recentFailures.length > 0 ? (
          <div className="stack-sm">
            <h3 style={{ margin: 0, fontSize: 14 }}>Recent failures (7 days)</h3>
            <ul style={{ margin: 0 }}>
              {j.recentFailures.map((f, i) => (
                <li key={i}>
                  {formatDateTime(f.createdAt)} ·{' '}
                  <code>
                    {f.queue}/{f.name}
                  </code>{' '}
                  · {f.status === 'DEAD' ? 'gave up' : 'will retry'} after {f.attempts} tries
                  {f.lastError ? `: ${f.lastError}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
