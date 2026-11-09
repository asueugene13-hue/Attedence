'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EntityDialog, EntityManager, type FormValues, num, orNull, text } from '@/components/entity-manager';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge, useAcademicOptions } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SetupOffering, SetupSection } from '@/lib/records';

interface Course {
  id: string;
  code: string;
  title: string;
  creditHours: number | null;
  departmentId: string;
  isActive: boolean;
}
interface Department {
  id: string;
  name: string;
}

const OFFERING_STATUS = {
  DRAFT: { label: 'Draft', tone: 'info' },
  OPEN: { label: 'Open', tone: 'success' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
} as const;

export default function CoursesPage() {
  return (
    <PermissionGate permission="academic_structure.read">
      <Courses />
    </PermissionGate>
  );
}

function Courses() {
  const auth = useAuth();
  const departments = useQuery({
    queryKey: ['departments', false],
    queryFn: () => auth.call<Department[]>('/departments'),
  });
  const departmentName = new Map((departments.data ?? []).map((d) => [d.id, d.name]));

  return (
    <div className="stack">
      <PageHeader
        title="Courses"
        subtitle="Courses belong to a department. Each semester a course runs as an offering (draft, then open, then closed), split into sections that students enrol in."
      />
      <EntityManager<Course>
        title="Courses"
        noun="course"
        listPath="/courses"
        queryKey={['courses']}
        managePermission="courses.manage"
        deactivatable
        columns={[
          { header: 'Code', cell: (r) => r.code },
          { header: 'Title', cell: (r) => r.title },
          { header: 'Department', cell: (r) => departmentName.get(r.departmentId) ?? '—' },
          { header: 'Credit hours', cell: (r) => r.creditHours ?? '—' },
        ]}
        fields={[
          {
            key: 'departmentId',
            label: 'Department',
            type: 'select',
            required: true,
            createOnly: true,
            options: (departments.data ?? []).map((d) => ({ value: d.id, label: d.name })),
          },
          { key: 'code', label: 'Code', required: true, hint: 'Stored in capitals.', maxLength: 20 },
          { key: 'title', label: 'Title', required: true },
          { key: 'creditHours', label: 'Credit hours', type: 'number', hint: 'Optional.' },
        ]}
        emptyForm={{ departmentId: '', code: '', title: '', creditHours: '' }}
        toForm={(r) => ({
          code: r.code,
          title: r.title,
          creditHours: r.creditHours === null ? '' : String(r.creditHours),
        })}
        toBody={(f, mode) => ({
          ...(mode === 'create' ? { departmentId: f.departmentId } : {}),
          code: text(f.code),
          title: text(f.title),
          creditHours: orNull(num(f.creditHours), mode),
        })}
        createPath="/courses"
        updatePath={(r) => `/courses/${r.id}`}
      />
      <Offerings />
    </div>
  );
}

type SectionDialog = { offering: SetupOffering; section?: SetupSection } | null;

function Offerings() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const academic = useAcademicOptions();
  const canManage = auth.can('courses.manage');
  const [semesterId, setSemesterId] = useState('');
  const [adding, setAdding] = useState(false);
  const [sectionDialog, setSectionDialog] = useState<SectionDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const courses = useQuery({ queryKey: ['courses', false], queryFn: () => auth.call<Course[]>('/courses') });
  const offerings = useQuery({
    queryKey: ['offerings', semesterId],
    enabled: Boolean(semesterId),
    queryFn: () => auth.call<SetupOffering[]>(`/course-offerings?semesterId=${semesterId}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['offerings'] });
  const semesters = academic.years.flatMap((y) =>
    y.semesters.map((s) => ({ value: s.id, label: `${y.label} · ${s.name}`, closed: s.status === 'CLOSED' })),
  );
  const offered = new Set((offerings.data ?? []).map((o) => o.course.id));

  async function setStatus(offering: SetupOffering, to: 'open' | 'close') {
    setError(null);
    try {
      await auth.call(`/course-offerings/${offering.id}/${to}`, { method: 'POST', body: {} });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const sectionInitial: FormValues = sectionDialog?.section
    ? {
        name: sectionDialog.section.name ?? '',
        capacity: sectionDialog.section.capacity === null ? '' : String(sectionDialog.section.capacity),
        programmeId: sectionDialog.section.programme?.id ?? '',
        levelId: sectionDialog.section.level?.id ?? '',
      }
    : { code: '', name: '', capacity: '', programmeId: '', levelId: '' };

  return (
    <section className="card" aria-labelledby="offerings-heading">
      <div className="card-header row">
        <h2 id="offerings-heading">Offerings and sections</h2>
        <span className="spacer" />
        {canManage && semesterId ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Offer a course this semester
          </Button>
        ) : null}
      </div>
      <div className="card-body stack">
        <SelectField
          label="Semester"
          name="semesterId"
          value={semesterId}
          onChange={setSemesterId}
          placeholder={academic.isPending ? 'Loading…' : 'Choose a semester'}
          options={semesters.map((s) => ({ value: s.value, label: s.label + (s.closed ? ' (closed)' : '') }))}
        />
        {error ? <Alert tone="error">{error}</Alert> : null}
        {offerings.isError ? <Alert tone="error">{describeError(offerings.error)}</Alert> : null}
        {semesterId && offerings.isPending ? <LoadingState /> : null}
        {offerings.data?.length === 0 ? (
          <p className="muted">No courses offered in this semester yet.</p>
        ) : null}
        {(offerings.data ?? []).map((o) => (
          <div key={o.id} className="card" style={{ boxShadow: 'none' }}>
            <div className="card-header row">
              <strong>
                {o.course.code} · {o.course.title}
              </strong>
              <StatusBadge tone={OFFERING_STATUS[o.status].tone} label={OFFERING_STATUS[o.status].label} />
              <span className="spacer" />
              {canManage && o.status === 'DRAFT' ? (
                <Button variant="ghost" size="sm" onClick={() => setStatus(o, 'open')}>
                  Open for enrolment
                </Button>
              ) : null}
              {canManage && o.status === 'OPEN' ? (
                <Button variant="ghost" size="sm" onClick={() => setStatus(o, 'close')}>
                  Close
                </Button>
              ) : null}
              {canManage && o.status !== 'CLOSED' ? (
                <Button variant="secondary" size="sm" onClick={() => setSectionDialog({ offering: o })}>
                  Add section
                </Button>
              ) : null}
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Section</th>
                    <th scope="col">Places</th>
                    <th scope="col">Programme / level</th>
                    <th scope="col">Lecturers</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {o.sections.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        No sections yet.
                      </td>
                    </tr>
                  ) : (
                    o.sections.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {s.code}
                          {s.name ? <span className="muted"> · {s.name}</span> : null}
                          {!s.isActive ? <span className="muted"> (inactive)</span> : null}
                        </td>
                        <td>{s.capacity ?? 'No limit'}</td>
                        <td className="secondary-text">
                          {[s.programme?.code, s.level?.name].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="secondary-text">
                          {s.assignments
                            .map((a) => a.lecturer.user.fullName + (a.isPrimary ? '' : ' (assistant)'))
                            .join(', ') || '—'}
                        </td>
                        <td>
                          <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                            <Link
                              className="btn btn-ghost btn-sm"
                              href={`/setup/courses/sections/${s.id}?semester=${semesterId}`}
                            >
                              Lecturers and reps
                            </Link>
                            {canManage && o.status !== 'CLOSED' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setSectionDialog({ offering: o, section: s })}
                              >
                                Edit
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <EntityDialog
        title="Offer a course this semester"
        open={adding}
        fields={[
          {
            key: 'courseId',
            label: 'Course',
            type: 'select',
            required: true,
            options: (courses.data ?? [])
              .filter((c) => !offered.has(c.id))
              .map((c) => ({ value: c.id, label: `${c.code} · ${c.title}` })),
          },
        ]}
        initial={{ courseId: '' }}
        submitLabel="Create offering"
        onSubmit={async (f) => {
          await auth.call('/course-offerings', {
            method: 'POST',
            body: { courseId: f.courseId, semesterId },
          });
          await refresh();
        }}
        onClose={() => setAdding(false)}
      />
      <EntityDialog
        title={sectionDialog?.section ? `Edit section ${sectionDialog.section.code}` : 'Add section'}
        open={sectionDialog !== null}
        fields={[
          ...(sectionDialog?.section
            ? []
            : [
                {
                  key: 'code',
                  label: 'Code',
                  required: true,
                  hint: 'Unique within this offering.',
                  maxLength: 20,
                },
              ]),
          { key: 'name', label: 'Name', hint: 'Optional.' },
          { key: 'capacity', label: 'Places', type: 'number', hint: 'Leave empty for no limit.' },
          {
            key: 'programmeId',
            label: 'Programme hint',
            type: 'select',
            hint: 'Optional. Used later to warn about timetable clashes.',
            options: academic.programmes.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })),
          },
          {
            key: 'levelId',
            label: 'Level hint',
            type: 'select',
            hint: 'Optional.',
            options: academic.levels.map((l) => ({ value: l.id, label: l.name })),
          },
        ]}
        initial={sectionInitial}
        onSubmit={async (f) => {
          const mode = sectionDialog?.section ? 'edit' : 'create';
          const body = {
            name: orNull(text(f.name), mode),
            capacity: orNull(num(f.capacity), mode),
            programmeId: orNull(text(f.programmeId), mode),
            levelId: orNull(text(f.levelId), mode),
          };
          if (sectionDialog?.section) {
            await auth.call(`/course-sections/${sectionDialog.section.id}`, { method: 'PATCH', body });
          } else {
            await auth.call('/course-sections', {
              method: 'POST',
              body: { offeringId: sectionDialog!.offering.id, code: text(f.code), ...body },
            });
          }
          await refresh();
        }}
        onClose={() => setSectionDialog(null)}
      />
    </section>
  );
}
