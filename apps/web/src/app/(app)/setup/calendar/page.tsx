'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EntityDialog, type FieldSpec, type FormValues, text } from '@/components/entity-manager';
import { PermissionGate } from '@/components/permission-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface SemesterRow {
  id: string;
  academicYearId: string;
  number: number;
  name: string;
  startDate: string;
  endDate: string;
  status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
}
interface YearRow {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  semesters: SemesterRow[];
}
interface ExceptionRow {
  id: string;
  semesterId: string | null;
  type: 'PUBLIC_HOLIDAY' | 'UNIVERSITY_CLOSURE' | 'EXAM_PERIOD' | 'OTHER';
  name: string;
  startDate: string;
  endDate: string;
  suppressesClasses: boolean;
}

const EXCEPTION_TYPES: Record<ExceptionRow['type'], string> = {
  PUBLIC_HOLIDAY: 'Public holiday',
  UNIVERSITY_CLOSURE: 'University closure',
  EXAM_PERIOD: 'Exam period',
  OTHER: 'Other',
};
const SEMESTER_TONE = { PLANNED: 'info', ACTIVE: 'success', CLOSED: 'neutral' } as const;
const SEMESTER_LABEL = { PLANNED: 'Planned', ACTIVE: 'Active', CLOSED: 'Closed' } as const;

type Dialog =
  | { kind: 'year'; row?: YearRow }
  | { kind: 'semester'; year: YearRow; row?: SemesterRow }
  | { kind: 'exception' };

export default function CalendarPage() {
  return (
    <PermissionGate permission="academic_structure.read">
      <Calendar />
    </PermissionGate>
  );
}

function Calendar() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canManage = auth.can('academic_periods.manage');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [removing, setRemoving] = useState<ExceptionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const years = useQuery({ queryKey: ['years'], queryFn: () => auth.call<YearRow[]>('/academic-years') });
  const exceptions = useQuery({
    queryKey: ['calendar-exceptions'],
    queryFn: () => auth.call<ExceptionRow[]>('/calendar-exceptions'),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['years'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar-exceptions'] }),
    ]);

  async function act(path: string) {
    setError(null);
    try {
      await auth.call(path, { method: 'POST', body: {} });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const allSemesters = (years.data ?? []).flatMap((y) =>
    y.semesters.map((s) => ({ ...s, yearLabel: y.label })),
  );
  const dialogSpec = specFor(dialog, allSemesters);

  return (
    <div className="stack">
      <PageHeader
        title="Academic calendar"
        subtitle="Academic years, their semesters, and holidays or closures when no classes run. Years and semesters may not overlap; one semester is active at a time."
        actions={
          canManage ? <Button onClick={() => setDialog({ kind: 'year' })}>Add academic year</Button> : null
        }
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {years.isError ? <Alert tone="error">{describeError(years.error)}</Alert> : null}
      {years.isPending ? <LoadingState /> : null}
      {years.data?.length === 0 ? <p className="muted">No academic years yet.</p> : null}

      {(years.data ?? []).map((year) => (
        <section key={year.id} className="card" aria-labelledby={`year-${year.id}`}>
          <div className="card-header row">
            <h2 id={`year-${year.id}`}>{year.label}</h2>
            {year.isCurrent ? <StatusBadge tone="success" label="Current year" /> : null}
            <span className="secondary-text">
              {year.startDate} to {year.endDate}
            </span>
            <span className="spacer" />
            {canManage ? (
              <>
                {!year.isCurrent ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => act(`/academic-years/${year.id}/make-current`)}
                  >
                    Make current
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'year', row: year })}>
                  Edit
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: 'semester', year })}>
                  Add semester
                </Button>
              </>
            ) : null}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">No.</th>
                  <th scope="col">Semester</th>
                  <th scope="col">Dates</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {year.semesters.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No semesters yet.
                    </td>
                  </tr>
                ) : (
                  year.semesters.map((s) => (
                    <tr key={s.id}>
                      <td>{s.number}</td>
                      <td>{s.name}</td>
                      <td className="secondary-text">
                        {s.startDate} to {s.endDate}
                      </td>
                      <td>
                        <StatusBadge tone={SEMESTER_TONE[s.status]} label={SEMESTER_LABEL[s.status]} />
                      </td>
                      <td>
                        {canManage ? (
                          <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                            {s.status === 'PLANNED' ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDialog({ kind: 'semester', year, row: s })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => act(`/semesters/${s.id}/activate`)}
                                >
                                  Activate
                                </Button>
                              </>
                            ) : null}
                            {s.status === 'ACTIVE' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => act(`/semesters/${s.id}/close`)}
                              >
                                Close
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="card" aria-labelledby="exceptions-heading">
        <div className="card-header row">
          <h2 id="exceptions-heading">Holidays and closures</h2>
          <span className="spacer" />
          {canManage ? (
            <Button size="sm" onClick={() => setDialog({ kind: 'exception' })}>
              Add holiday or closure
            </Button>
          ) : null}
        </div>
        {exceptions.isError ? <Alert tone="error">{describeError(exceptions.error)}</Alert> : null}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Dates</th>
                <th scope="col">Classes</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(exceptions.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {exceptions.isPending ? 'Loading…' : 'None entered.'}
                  </td>
                </tr>
              ) : (
                exceptions.data!.map((e) => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td className="secondary-text">{EXCEPTION_TYPES[e.type]}</td>
                    <td className="secondary-text">
                      {e.startDate === e.endDate ? e.startDate : `${e.startDate} to ${e.endDate}`}
                    </td>
                    <td className="secondary-text">
                      {e.suppressesClasses ? 'No classes' : 'Classes still run'}
                    </td>
                    <td>
                      {canManage ? (
                        <Button variant="ghost" size="sm" onClick={() => setRemoving(e)}>
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <EntityDialog
        title={dialogSpec.title}
        open={dialog !== null}
        fields={dialogSpec.fields}
        initial={dialogSpec.initial}
        onSubmit={async (form) => {
          const { path, method, body } = dialogSpec.request(form);
          await auth.call(path, { method, body });
          await refresh();
        }}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name}` : 'Remove'}
        description="Only entries that have not started can be removed; past ones stay because past classes depended on them."
        confirmLabel="Remove"
        destructive
        onConfirm={async (reason) => {
          await auth.call(`/calendar-exceptions/${removing!.id}/remove`, {
            method: 'POST',
            body: { reason },
          });
          await refresh();
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

const dates: FieldSpec[] = [
  { key: 'startDate', label: 'Starts', type: 'date', required: true },
  { key: 'endDate', label: 'Ends', type: 'date', required: true },
];

/** The fields and request for whichever dialog is open. */
function specFor(
  dialog: Dialog | null,
  semesters: (SemesterRow & { yearLabel: string })[],
): {
  title: string;
  fields: FieldSpec[];
  initial: FormValues;
  request: (f: FormValues) => { path: string; method: 'POST' | 'PATCH'; body: object };
} {
  const none = {
    title: '',
    fields: [],
    initial: {},
    request: () => ({ path: '', method: 'POST' as const, body: {} }),
  };
  if (!dialog) return none;
  if (dialog.kind === 'year') {
    const row = dialog.row;
    return {
      title: row ? `Edit ${row.label}` : 'Add academic year',
      fields: [
        { key: 'label', label: 'Label', required: true, hint: 'As the university writes it.' },
        ...dates,
      ],
      initial: row
        ? { label: row.label, startDate: row.startDate, endDate: row.endDate }
        : { label: '', startDate: '', endDate: '' },
      request: (f) => ({
        path: row ? `/academic-years/${row.id}` : '/academic-years',
        method: row ? 'PATCH' : 'POST',
        body: { label: text(f.label), startDate: text(f.startDate), endDate: text(f.endDate) },
      }),
    };
  }
  if (dialog.kind === 'semester') {
    const row = dialog.row;
    return {
      title: row ? `Edit ${row.name}` : `Add semester to ${dialog.year.label}`,
      fields: [
        ...(row
          ? []
          : [
              {
                key: 'number',
                label: 'Number',
                type: 'number' as const,
                required: true,
                hint: '1 to 4, within the year.',
              },
            ]),
        { key: 'name', label: 'Name', required: true },
        ...dates,
      ],
      initial: row
        ? { name: row.name, startDate: row.startDate, endDate: row.endDate }
        : { number: '', name: '', startDate: '', endDate: '' },
      request: (f) =>
        row
          ? {
              path: `/semesters/${row.id}`,
              method: 'PATCH',
              body: { name: text(f.name), startDate: text(f.startDate), endDate: text(f.endDate) },
            }
          : {
              path: '/semesters',
              method: 'POST',
              body: {
                academicYearId: dialog.year.id,
                number: Number(f.number),
                name: text(f.name),
                startDate: text(f.startDate),
                endDate: text(f.endDate),
              },
            },
    };
  }
  return {
    title: 'Add holiday or closure',
    fields: [
      { key: 'name', label: 'Name', required: true },
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        required: true,
        options: Object.entries(EXCEPTION_TYPES).map(([value, label]) => ({ value, label })),
      },
      {
        key: 'semesterId',
        label: 'Semester',
        type: 'select',
        hint: 'Optional.',
        options: semesters.map((s) => ({ value: s.id, label: `${s.yearLabel} · ${s.name}` })),
      },
      ...dates,
      { key: 'suppressesClasses', label: 'No classes on these days', type: 'checkbox' },
    ],
    initial: { name: '', type: '', semesterId: '', startDate: '', endDate: '', suppressesClasses: true },
    request: (f) => ({
      path: '/calendar-exceptions',
      method: 'POST',
      body: {
        name: text(f.name),
        type: f.type,
        semesterId: text(f.semesterId),
        startDate: text(f.startDate),
        endDate: text(f.endDate),
        suppressesClasses: Boolean(f.suppressesClasses),
      },
    }),
  };
}
