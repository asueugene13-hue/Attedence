'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { TIMETABLE_STATUS, type TimetableSummary } from '@/lib/classes';
import type { AcademicYear } from '@/lib/records';

/** Timetable versions per semester: one draft and one published at a time. */
export default function TimetablesPage() {
  const auth = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const years = useQuery({
    queryKey: ['years'],
    queryFn: () => auth.call<AcademicYear[]>('/academic-years'),
  });
  const semesters = (years.data ?? []).flatMap((y) =>
    y.semesters.map((s) => ({
      value: s.id,
      label: `${y.label} · ${s.name}${s.status === 'CLOSED' ? ' (closed)' : ''}`,
    })),
  );
  const [semesterId, setSemesterId] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const timetables = useQuery({
    queryKey: ['timetables', semesterId],
    enabled: Boolean(semesterId),
    queryFn: () => auth.call<TimetableSummary[]>(`/timetables?semesterId=${semesterId}`),
  });
  const hasDraft = (timetables.data ?? []).some((t) => t.status === 'DRAFT');

  return (
    <div className="stack">
      <PageHeader
        title="Timetables"
        subtitle="Build a semester's timetable as a draft, check it for clashes, then publish it. A new version starts as a copy of the published one."
        actions={
          auth.can('timetables.manage') && semesterId && !hasDraft ? (
            <Button onClick={() => setCreating(true)}>New draft</Button>
          ) : null
        }
      />
      {years.isError ? <Alert tone="error">{describeError(years.error)}</Alert> : null}
      <SelectField
        label="Semester"
        name="semesterId"
        value={semesterId}
        onChange={setSemesterId}
        placeholder={years.isPending ? 'Loading…' : 'Choose a semester'}
        options={semesters}
      />
      {timetables.isPending && semesterId ? <LoadingState /> : null}
      {timetables.isError ? <Alert tone="error">{describeError(timetables.error)}</Alert> : null}
      {timetables.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Entries</th>
                <th scope="col">Published</th>
              </tr>
            </thead>
            <tbody>
              {timetables.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No timetable for this semester yet.
                  </td>
                </tr>
              ) : (
                timetables.data.map((t) => (
                  <tr key={t.id}>
                    <td>{t.version}</td>
                    <td>
                      <Link href={`/timetables/${t.id}`}>{t.name}</Link>
                    </td>
                    <td>
                      <StatusBadge
                        tone={TIMETABLE_STATUS[t.status].tone}
                        label={TIMETABLE_STATUS[t.status].label}
                      />
                    </td>
                    <td>{t._count.entries}</td>
                    <td>{formatDateTime(t.publishedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? (
        <FormDialog
          open
          title="New timetable draft"
          description="If this semester has a published timetable, the draft starts as a copy of it."
          submitLabel="Create draft"
          validate={() => (name.trim().length < 2 ? 'Give the draft a name.' : null)}
          onSubmit={async () => {
            const created = await auth.call<{ id: string }>('/timetables', {
              method: 'POST',
              body: { semesterId, name: name.trim() },
            });
            await queryClient.invalidateQueries({ queryKey: ['timetables', semesterId] });
            router.push(`/timetables/${created.id}`);
          }}
          onClose={() => setCreating(false)}
        >
          <Field label="Name" name="name" value={name} onChange={setName} maxLength={120} />
        </FormDialog>
      ) : null}
    </div>
  );
}
