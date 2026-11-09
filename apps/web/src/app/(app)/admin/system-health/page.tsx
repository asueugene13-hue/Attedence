'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

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
