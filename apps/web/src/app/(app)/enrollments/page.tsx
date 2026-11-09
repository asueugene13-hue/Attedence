'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { Counts, SelectField, useAcademicOptions } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import type { Offering, Roster, StudentView } from '@/lib/records';
import type { Page } from '@/lib/types';

export default function EnrollmentsPage() {
  return (
    <PermissionGate permission="enrollments.manage">
      <Enrollments />
    </PermissionGate>
  );
}

function Enrollments() {
  const auth = useAuth();
  const academic = useAcademicOptions();
  const [semesterId, setSemesterId] = useState('');
  const [sectionId, setSectionId] = useState('');

  const semesters = academic.years.flatMap((y) =>
    y.semesters.map((s) => ({
      ...s,
      label: `${y.label} · ${s.name}${s.status === 'CLOSED' ? ' (closed)' : ''}`,
    })),
  );
  const offerings = useQuery({
    queryKey: ['offerings', semesterId],
    enabled: Boolean(semesterId),
    queryFn: () => auth.call<Offering[]>(`/course-offerings?semesterId=${semesterId}`),
  });
  const sections = (offerings.data ?? []).flatMap((o) =>
    o.sections.map((s) => ({
      value: s.id,
      label: `${o.course.code} ${o.course.title} · section ${s.code}${o.status === 'CLOSED' ? ' (closed)' : ''}`,
    })),
  );

  return (
    <div className="stack">
      <PageHeader
        title="Enrolments"
        subtitle="Which students are in each course section. Choose a semester and a section to see and change its list."
        actions={
          auth.can('enrollments.manage') ? (
            <Link className="btn btn-secondary" href="/imports?type=enrollments">
              Bulk enrol from a file
            </Link>
          ) : null
        }
      />
      {academic.error ? <Alert tone="error">{describeError(academic.error)}</Alert> : null}
      <div className="row">
        <SelectField
          label="Semester"
          name="semesterId"
          value={semesterId}
          onChange={(v) => {
            setSemesterId(v);
            setSectionId('');
          }}
          placeholder={academic.isPending ? 'Loading…' : 'Choose a semester'}
          options={semesters.map((s) => ({ value: s.id, label: s.label }))}
        />
        <SelectField
          label="Course section"
          name="sectionId"
          value={sectionId}
          disabled={!semesterId}
          onChange={setSectionId}
          placeholder={
            !semesterId
              ? 'Choose a semester first'
              : sections.length
                ? 'Choose a section'
                : 'No course sections in this semester'
          }
          options={sections}
        />
      </div>
      {offerings.isError ? <Alert tone="error">{describeError(offerings.error)}</Alert> : null}
      {sectionId ? <SectionRoster sectionId={sectionId} /> : null}
    </div>
  );
}

function SectionRoster({ sectionId }: { sectionId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const roster = useQuery({
    queryKey: ['roster', sectionId],
    queryFn: () => auth.call<Roster>(`/course-sections/${sectionId}/students`),
  });
  const [studentNumber, setStudentNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropping, setDropping] = useState<Roster['students'][number] | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['roster', sectionId] }),
      queryClient.invalidateQueries({ queryKey: ['enrollments'] }),
      // Dropping a student ends their course-rep role for this section.
      queryClient.invalidateQueries({ queryKey: ['course-reps', sectionId] }),
    ]);

  async function enrol(event: React.FormEvent) {
    event.preventDefault();
    const number = studentNumber.trim();
    if (!number) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const found = await auth.call<Page<StudentView>>(`/students?q=${encodeURIComponent(number)}&limit=5`);
      const student = found.data.find((s) => s.studentNumber === number);
      if (!student) {
        setError(`No student has the Student ID ${number}.`);
        return;
      }
      await auth.call('/enrollments', { method: 'POST', body: { studentId: student.id, sectionId } });
      setStudentNumber('');
      setNotice(`${student.fullName} (${student.studentNumber}) enrolled.`);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (roster.isPending) return <LoadingState />;
  if (roster.isError) return <Alert tone="error">{describeError(roster.error)}</Alert>;
  const r = roster.data;

  return (
    <section className="card" aria-labelledby="roster-heading">
      <div className="card-header">
        <h2 id="roster-heading">
          {r.section.course.code} · section {r.section.code}
        </h2>
      </div>
      <div className="card-body stack">
        <Counts
          items={[
            { label: 'Enrolled', value: r.enrolledCount },
            ...(r.section.capacity !== null
              ? [{ label: 'Places left', value: Math.max(0, r.section.capacity - r.enrolledCount) }]
              : []),
          ]}
        />
        {r.section.capacity === null ? <p className="muted">This section has no capacity limit.</p> : null}
        <form className="row" onSubmit={enrol} aria-label="Enrol a student">
          <Field
            label="Enrol by Student ID"
            name="studentNumber"
            inputMode="numeric"
            maxLength={8}
            value={studentNumber}
            onChange={setStudentNumber}
          />
          <Button
            type="submit"
            variant="secondary"
            busy={busy}
            disabled={!studentNumber.trim()}
            style={{ alignSelf: 'flex-end' }}
          >
            Enrol
          </Button>
        </form>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Student ID</th>
              <th scope="col">Name</th>
              <th scope="col">Programme</th>
              <th scope="col">Level</th>
              <th scope="col">Enrolled</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {r.students.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No students enrolled yet.
                </td>
              </tr>
            ) : (
              r.students.map((s) => (
                <tr key={s.enrollmentId}>
                  <td>
                    <Link href={`/students/${s.studentId}`}>{s.studentNumber}</Link>
                  </td>
                  <td>{s.fullName}</td>
                  <td className="secondary-text">{s.programme.code}</td>
                  <td className="secondary-text">{s.level.name}</td>
                  <td className="secondary-text">{formatDateTime(s.enrolledAt)}</td>
                  <td>
                    <Button variant="ghost" size="sm" onClick={() => setDropping(s)}>
                      Drop
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <ReasonDialog
        open={dropping !== null}
        title={dropping ? `Drop ${dropping.fullName}` : 'Drop'}
        description="The enrolment is kept as history and the student can be enrolled again later. A course-rep role for this section ends with it."
        confirmLabel="Drop enrolment"
        destructive
        onConfirm={async (reason) => {
          await auth.call(`/enrollments/${dropping!.enrollmentId}/end`, {
            method: 'POST',
            body: { status: 'DROPPED', reason },
          });
          await refresh();
        }}
        onClose={() => setDropping(null)}
      />
    </section>
  );
}
