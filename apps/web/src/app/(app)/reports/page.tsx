'use client';

import { ATTENDANCE_GROUPS, CLASS_GROUPS } from '@attendsure/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ExportButtons, MyExports } from '@/components/exports';
import { SelectField } from '@/components/records';
import { Alert, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Semester {
  id: string;
  name: string;
  status: string;
  academicYear: { label: string };
}
interface Offering {
  id: string;
  course: { code: string; title: string };
  sections: { id: string; code: string }[];
}
interface Teaching {
  sections: { sectionId: string; sectionCode: string; course: { code: string; title: string } }[];
}
interface AttendanceRow {
  key: string;
  label: string;
  students: number;
  present: number;
  late: number;
  absences: number;
  excused: number;
  undecided: number;
  percentage: number | null;
  belowMinimum: number | null;
}
interface ClassRow {
  key: string;
  label: string;
  scheduled: number;
  held: number;
  cancelled: number;
  rescheduled: number;
  suspended: number;
  stillToCome: number;
  delayed: number;
  unconfirmed: number;
  reviewed: number;
  averageLateStartMinutes: number | null;
}
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * Reports (Phase 7): analytics for administrators, class-group files for lecturers and administrators,
 * the Registrar's student list, and the person's own files. Every number comes from the server, within
 * the person's scope; every file asked for and downloaded is logged.
 */
export default function ReportsPage() {
  const { me } = useAuth();
  if (!me) return null;
  const has = (p: string) => me.permissions.includes(p);
  const isAdmin = me.activeRole === 'SUPER_ADMIN' || me.activeRole === 'UNIVERSITY_ADMIN';
  return (
    <div className="stack">
      <PageHeader
        title="Reports"
        subtitle="Worked out from the records when you ask, within what you may see. Files are kept for 7 days; each request and download is logged."
      />
      {has('analytics.read') && isAdmin ? <Analytics /> : null}
      {has('reports.course') && me.activeRole === 'LECTURER' ? <MyClassGroups /> : null}
      {has('reports.course') && isAdmin ? <AnyClassGroup /> : null}
      {has('reports.registrar') ? <Registrar /> : null}
      <section className="card" aria-labelledby="files-heading">
        <div className="card-header">
          <h2 id="files-heading">Your files</h2>
        </div>
        <div className="card-body">
          <MyExports />
        </div>
      </section>
      {has('audit_logs.read') && me.activeRole === 'SUPER_ADMIN' ? (
        <section className="card" aria-labelledby="log-heading">
          <div className="card-header">
            <h2 id="log-heading">Export log</h2>
            <div className="muted">Every file anyone asked for, for accountability.</div>
          </div>
          <div className="card-body">
            <MyExports all />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function useSemesters() {
  const auth = useAuth();
  return useQuery({ queryKey: ['semesters'], queryFn: () => auth.call<Semester[]>('/semesters') });
}

function SemesterPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const semesters = useSemesters();
  return (
    <SelectField
      label="Semester"
      name="semester"
      value={value}
      onChange={onChange}
      options={[
        { value: '', label: 'The active semester' },
        ...(semesters.data ?? []).map((s) => ({ value: s.id, label: `${s.name} · ${s.academicYear.label}` })),
      ]}
    />
  );
}

function Analytics() {
  const auth = useAuth();
  const [semesterId, setSemesterId] = useState('');
  const [groupBy, setGroupBy] = useState<(typeof ATTENDANCE_GROUPS)[number]>('department');
  const [classGroup, setClassGroup] = useState<(typeof CLASS_GROUPS)[number]>('department');
  const q = semesterId ? `semesterId=${semesterId}&` : '';
  const attendance = useQuery({
    queryKey: ['analytics', 'attendance', semesterId, groupBy],
    queryFn: () =>
      auth.call<{
        rows: AttendanceRow[];
        totals: { percentage: number | null };
        minimumPercent: number | null;
        semester: { name: string };
      }>(`/analytics/attendance?${q}groupBy=${groupBy}`),
  });
  const classes = useQuery({
    queryKey: ['analytics', 'classes', semesterId, classGroup],
    queryFn: () => auth.call<{ rows: ClassRow[] }>(`/analytics/classes?${q}groupBy=${classGroup}`),
  });
  const semester = semesterId ? { semesterId } : {};
  return (
    <>
      <section className="card" aria-labelledby="attendance-heading">
        <div className="card-header">
          <h2 id="attendance-heading">Attendance</h2>
          <div className="muted">
            Same rules as each student’s own percentage: held classes with attendance taken; excused and
            undecided check-ins left out.
          </div>
        </div>
        <div className="card-body stack">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ minWidth: 240 }}>
              <SemesterPicker value={semesterId} onChange={setSemesterId} />
            </div>
            <div style={{ minWidth: 200 }}>
              <SelectField
                label="Group by"
                name="groupBy"
                value={groupBy}
                onChange={(v) => setGroupBy(v as typeof groupBy)}
                options={ATTENDANCE_GROUPS.map((g) => ({ value: g, label: cap(g) }))}
              />
            </div>
          </div>
          {attendance.isPending ? <LoadingState /> : null}
          {attendance.isError ? <Alert tone="error">{describeError(attendance.error)}</Alert> : null}
          {attendance.data ? (
            <>
              <p className="muted" style={{ margin: 0 }}>
                {attendance.data.semester.name} · overall {pct(attendance.data.totals.percentage)} ·{' '}
                {attendance.data.minimumPercent === null
                  ? 'no minimum set yet'
                  : `minimum ${attendance.data.minimumPercent}%`}
              </p>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">{cap(groupBy)}</th>
                      <th scope="col">Students</th>
                      <th scope="col">Present</th>
                      <th scope="col">Late</th>
                      <th scope="col">Absences</th>
                      <th scope="col">Excused</th>
                      <th scope="col">Undecided</th>
                      <th scope="col">Attendance</th>
                      <th scope="col">Below minimum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendance.data.rows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="muted">
                          No attendance counted yet.
                        </td>
                      </tr>
                    ) : (
                      attendance.data.rows.map((r) => (
                        <tr key={r.key}>
                          <td>{r.label}</td>
                          <td>{r.students}</td>
                          <td>{r.present}</td>
                          <td>{r.late}</td>
                          <td>{r.absences}</td>
                          <td>{r.excused}</td>
                          <td>{r.undecided}</td>
                          <td>{pct(r.percentage)}</td>
                          <td>{r.belowMinimum ?? '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <ExportButtons
                request={{ reportType: 'ATTENDANCE_ANALYTICS', params: { ...semester, groupBy } }}
              />
            </>
          ) : null}
        </div>
      </section>
      <section className="card" aria-labelledby="classes-heading">
        <div className="card-header">
          <h2 id="classes-heading">Class operations</h2>
        </div>
        <div className="card-body stack">
          <div style={{ maxWidth: 220 }}>
            <SelectField
              label="Group by"
              name="classGroup"
              value={classGroup}
              onChange={(v) => setClassGroup(v as typeof classGroup)}
              options={CLASS_GROUPS.map((g) => ({ value: g, label: cap(g) }))}
            />
          </div>
          {classes.isPending ? <LoadingState /> : null}
          {classes.isError ? <Alert tone="error">{describeError(classes.error)}</Alert> : null}
          {classes.data ? (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">{cap(classGroup)}</th>
                      <th scope="col">Scheduled</th>
                      <th scope="col">Held</th>
                      <th scope="col">Cancelled</th>
                      <th scope="col">Rescheduled</th>
                      <th scope="col">Suspended</th>
                      <th scope="col">Still to come</th>
                      <th scope="col">Delay reported</th>
                      <th scope="col">Unconfirmed</th>
                      <th scope="col">Reviewed</th>
                      <th scope="col">Average late start</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classes.data.rows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="muted">
                          No classes in this semester.
                        </td>
                      </tr>
                    ) : (
                      classes.data.rows.map((r) => (
                        <tr key={r.key}>
                          <td>{r.label}</td>
                          <td>{r.scheduled}</td>
                          <td>{r.held}</td>
                          <td>{r.cancelled}</td>
                          <td>{r.rescheduled}</td>
                          <td>{r.suspended}</td>
                          <td>{r.stillToCome}</td>
                          <td>{r.delayed}</td>
                          <td>{r.unconfirmed}</td>
                          <td>{r.reviewed}</td>
                          <td>
                            {r.averageLateStartMinutes === null ? '—' : `${r.averageLateStartMinutes} min`}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <ExportButtons
                request={{ reportType: 'CLASS_OPERATIONS', params: { ...semester, groupBy: classGroup } }}
              />
            </>
          ) : null}
        </div>
      </section>
    </>
  );
}

function SectionFiles({ sectionId, title }: { sectionId: string; title: string }) {
  return (
    <li
      className="stack-sm"
      style={{ padding: '12px 0', borderBottom: '1px solid var(--color-border-subtle)' }}
    >
      <strong>{title}</strong>
      <ExportButtons
        label="Attendance summary"
        request={{ reportType: 'SECTION_SUMMARY', params: { sectionId } }}
      />
      <ExportButtons
        label="Register (student by class)"
        request={{ reportType: 'SECTION_REGISTER', params: { sectionId } }}
      />
    </li>
  );
}

function MyClassGroups() {
  const auth = useAuth();
  const teaching = useQuery({
    queryKey: ['me', 'teaching'],
    queryFn: () => auth.call<Teaching>('/me/teaching'),
  });
  return (
    <section className="card" aria-labelledby="groups-heading">
      <div className="card-header">
        <h2 id="groups-heading">Your class groups</h2>
      </div>
      <div className="card-body">
        {teaching.isPending ? <LoadingState /> : null}
        {teaching.isError ? <Alert tone="error">{describeError(teaching.error)}</Alert> : null}
        {teaching.data?.sections.length === 0 ? (
          <p className="muted">You are not teaching any class group now.</p>
        ) : null}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {teaching.data?.sections.map((s) => (
            <SectionFiles
              key={s.sectionId}
              sectionId={s.sectionId}
              title={`${s.course.code} · ${s.sectionCode} · ${s.course.title}`}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function AnyClassGroup() {
  const auth = useAuth();
  const [semesterId, setSemesterId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const semesters = useSemesters();
  const chosen = semesterId || semesters.data?.find((s) => s.status === 'ACTIVE')?.id || '';
  const offerings = useQuery({
    queryKey: ['offerings', chosen],
    enabled: !!chosen,
    queryFn: () => auth.call<Offering[]>(`/course-offerings?semesterId=${chosen}`),
  });
  const options = (offerings.data ?? []).flatMap((o) =>
    o.sections.map((s) => ({ value: s.id, label: `${o.course.code} · ${s.code} · ${o.course.title}` })),
  );
  const picked = options.find((o) => o.value === sectionId);
  return (
    <section className="card" aria-labelledby="any-group-heading">
      <div className="card-header">
        <h2 id="any-group-heading">Class group files</h2>
        <div className="muted">Only class groups in your area can be made.</div>
      </div>
      <div className="card-body stack">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 240 }}>
            <SemesterPicker
              value={semesterId}
              onChange={(v) => {
                setSemesterId(v);
                setSectionId('');
              }}
            />
          </div>
          <div style={{ minWidth: 300 }}>
            <SelectField
              label="Class group"
              name="section"
              value={sectionId}
              onChange={setSectionId}
              placeholder="Choose a class group"
              options={options}
            />
          </div>
        </div>
        {picked ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            <SectionFiles sectionId={picked.value} title={picked.label} />
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function Registrar() {
  const [semesterId, setSemesterId] = useState('');
  return (
    <section className="card" aria-labelledby="registrar-heading">
      <div className="card-header">
        <h2 id="registrar-heading">Students and enrolments</h2>
        <div className="muted">Every enrolment in a semester’s courses, current and ended.</div>
      </div>
      <div className="card-body stack">
        <div style={{ maxWidth: 280 }}>
          <SemesterPicker value={semesterId} onChange={setSemesterId} />
        </div>
        <ExportButtons
          request={{ reportType: 'STUDENT_ENROLMENTS', params: semesterId ? { semesterId } : {} }}
        />
      </div>
    </section>
  );
}
