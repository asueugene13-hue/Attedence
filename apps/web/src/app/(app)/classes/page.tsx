'use client';

import { CLASS_STATUSES } from '@attendsure/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ClassTable } from '@/components/class-list';
import { PermissionGate } from '@/components/permission-gate';
import { Counts, SelectField } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addDays, type ClassSessionView, STATUS_DISPLAY, todayInAccra } from '@/lib/classes';

export default function ClassMonitorPage() {
  return (
    <PermissionGate permission="class_reviews.decide">
      <ClassMonitor />
    </PermissionGate>
  );
}

/** Every class on one day, as the server sees it right now (refreshed every 30 seconds). */
function ClassMonitor() {
  const auth = useAuth();
  const [day, setDay] = useState(todayInAccra());
  const [status, setStatus] = useState('');
  const sessions = useQuery({
    queryKey: ['class-sessions', day, status],
    queryFn: () =>
      auth.call<{ data: ClassSessionView[] }>(
        `/class-sessions?from=${day}&to=${day}${status ? `&status=${status}` : ''}`,
      ),
    refetchInterval: 30_000,
  });
  const rows = sessions.data?.data ?? [];
  const count = (...s: string[]) => rows.filter((r) => s.includes(r.status)).length;

  return (
    <div className="stack">
      <PageHeader
        title="Class monitor"
        subtitle="Every class on the chosen day, with its status as the server decided it. Open a class to see its history and act on it."
      />
      <div className="row">
        <Button variant="secondary" size="sm" onClick={() => setDay(addDays(day, -1))}>
          Previous day
        </Button>
        <Field label="Day" name="day" type="date" value={day} onChange={(v) => v && setDay(v)} />
        <Button variant="secondary" size="sm" onClick={() => setDay(addDays(day, 1))}>
          Next day
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDay(todayInAccra())}>
          Today
        </Button>
        <SelectField
          label="Status"
          name="status"
          value={status}
          onChange={setStatus}
          placeholder="All statuses"
          options={CLASS_STATUSES.map((s) => ({ value: s, label: STATUS_DISPLAY[s].label }))}
        />
      </div>
      {sessions.isPending ? <LoadingState /> : null}
      {sessions.isError ? <Alert tone="error">{describeError(sessions.error)}</Alert> : null}
      {sessions.data ? (
        <>
          {!status ? (
            <Counts
              items={[
                { label: 'Classes', value: rows.length },
                { label: 'In progress', value: count('ACTIVE', 'INTERRUPTED'), tone: 'success' },
                { label: 'Not confirmed', value: count('UNCONFIRMED'), tone: 'warning' },
                { label: 'Under review', value: count('UNDER_REVIEW'), tone: 'error' },
                { label: 'Cancelled', value: count('CANCELLED'), tone: 'error' },
              ]}
            />
          ) : null}
          <ClassTable sessions={rows} empty="No classes on this day." />
        </>
      ) : null}
    </div>
  );
}
