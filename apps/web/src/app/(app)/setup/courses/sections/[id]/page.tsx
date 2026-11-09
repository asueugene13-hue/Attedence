'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EntityDialog } from '@/components/entity-manager';
import { PermissionGate } from '@/components/permission-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { StatusBadge } from '@/components/records';
import { Alert, Button, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import type { CourseRepView, Roster, SetupOffering, SetupSection } from '@/lib/records';

interface Lecturer {
  id: string;
  staffNumber: string;
  title: string | null;
  status: string;
  user: { fullName: string };
}

const REP_STATUS = {
  NOMINATED: { label: 'Nominated', tone: 'warning' },
  ACTIVE: { label: 'Course rep', tone: 'success' },
  ENDED: { label: 'Ended', tone: 'neutral' },
  REJECTED: { label: 'Not approved', tone: 'neutral' },
} as const;

export default function SectionPage() {
  return (
    <PermissionGate permission="academic_structure.read">
      <Suspense fallback={<LoadingState />}>
        <SectionDetail />
      </Suspense>
    </PermissionGate>
  );
}

function SectionDetail() {
  const auth = useAuth();
  const { id } = useParams<{ id: string }>();
  const semesterId = useSearchParams().get('semester') ?? '';
  const offerings = useQuery({
    queryKey: ['offerings', semesterId],
    enabled: Boolean(semesterId),
    queryFn: () => auth.call<SetupOffering[]>(`/course-offerings?semesterId=${semesterId}`),
  });
  const offering = offerings.data?.find((o) => o.sections.some((s) => s.id === id));
  const section = offering?.sections.find((s) => s.id === id);

  if (!semesterId) return <Alert tone="error">Open this page from Courses, so the semester is known.</Alert>;
  if (offerings.isPending) return <LoadingState />;
  if (offerings.isError) return <Alert tone="error">{describeError(offerings.error)}</Alert>;
  if (!offering || !section) return <Alert tone="error">No such section in that semester.</Alert>;

  return (
    <div className="stack">
      <PageHeader
        title={`${offering.course.code} · section ${section.code}`}
        subtitle={`${offering.course.title} · ${offering.semester.academicYear.label} ${offering.semester.name}`}
        actions={
          <Link className="btn btn-secondary" href="/setup/courses">
            All courses
          </Link>
        }
      />
      <LecturersCard section={section} closed={offering.status === 'CLOSED'} />
      <RepsCard sectionId={section.id} />
    </div>
  );
}

function LecturersCard({ section, closed }: { section: SetupSection; closed: boolean }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canAssign = auth.can('lecturer_assignments.manage') && !closed;
  const [assigning, setAssigning] = useState(false);
  const [ending, setEnding] = useState<SetupSection['assignments'][number] | null>(null);
  const lecturers = useQuery({
    queryKey: ['lecturers'],
    enabled: canAssign,
    queryFn: () => auth.call<Lecturer[]>('/lecturers'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['offerings'] });
  const assigned = new Set(section.assignments.map((a) => a.lecturer.id));

  return (
    <section className="card" aria-labelledby="lecturers-heading">
      <div className="card-header row">
        <h2 id="lecturers-heading">Lecturers</h2>
        <span className="spacer" />
        {canAssign ? (
          <Button size="sm" onClick={() => setAssigning(true)}>
            Assign lecturer
          </Button>
        ) : null}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Lecturer</th>
              <th scope="col">Staff number</th>
              <th scope="col">Role</th>
              <th scope="col">Since</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {section.assignments.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No lecturer assigned yet.
                </td>
              </tr>
            ) : (
              section.assignments.map((a) => (
                <tr key={a.id}>
                  <td>{[a.lecturer.title, a.lecturer.user.fullName].filter(Boolean).join(' ')}</td>
                  <td className="secondary-text">{a.lecturer.staffNumber}</td>
                  <td>{a.isPrimary ? 'Primary lecturer' : 'Assistant'}</td>
                  <td className="secondary-text">{formatDateTime(a.assignedAt)}</td>
                  <td>
                    {canAssign ? (
                      <Button variant="ghost" size="sm" onClick={() => setEnding(a)}>
                        End assignment
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <EntityDialog
        title="Assign lecturer"
        open={assigning}
        fields={[
          {
            key: 'lecturerId',
            label: 'Lecturer',
            type: 'select',
            required: true,
            options: (lecturers.data ?? [])
              .filter((l) => l.status !== 'INACTIVE' && !assigned.has(l.id))
              .map((l) => ({ value: l.id, label: `${l.user.fullName} (${l.staffNumber})` })),
          },
          {
            key: 'isPrimary',
            label: 'Primary lecturer (one per section; others are assistants)',
            type: 'checkbox',
          },
        ]}
        initial={{ lecturerId: '', isPrimary: section.assignments.every((a) => !a.isPrimary) }}
        submitLabel="Assign"
        onSubmit={async (f) => {
          await auth.call(`/course-sections/${section.id}/lecturers`, {
            method: 'POST',
            body: { lecturerId: f.lecturerId, isPrimary: Boolean(f.isPrimary) },
          });
          await refresh();
        }}
        onClose={() => setAssigning(false)}
      />
      <ReasonDialog
        open={ending !== null}
        title={ending ? `End ${ending.lecturer.user.fullName}'s assignment` : 'End assignment'}
        description="The assignment is kept for history. The lecturer stops seeing this section in their teaching list."
        confirmLabel="End assignment"
        destructive
        onConfirm={async (reason) => {
          await auth.call(`/course-sections/${section.id}/lecturers/${ending!.id}/end`, {
            method: 'POST',
            body: { reason },
          });
          await refresh();
        }}
        onClose={() => setEnding(null)}
      />
    </section>
  );
}

function RepsCard({ sectionId }: { sectionId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canAssign = auth.can('course_reps.assign');
  const canNominate = auth.can('course_reps.nominate');
  const [adding, setAdding] = useState<'appoint' | 'nominate' | null>(null);
  const [deciding, setDeciding] = useState<{ rep: CourseRepView; action: 'reject' | 'end' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reps = useQuery({
    queryKey: ['course-reps', sectionId],
    queryFn: () => auth.call<{ data: CourseRepView[] }>(`/course-sections/${sectionId}/course-reps`),
  });
  const roster = useQuery({
    queryKey: ['roster', sectionId],
    enabled: adding !== null,
    queryFn: () => auth.call<Roster>(`/course-sections/${sectionId}/students`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['course-reps', sectionId] });
  const open = new Set(
    (reps.data?.data ?? [])
      .filter((r) => r.status === 'ACTIVE' || r.status === 'NOMINATED')
      .map((r) => r.student.id),
  );

  async function approve(rep: CourseRepView) {
    setError(null);
    try {
      await auth.call(`/course-reps/${rep.id}/approve`, { method: 'POST', body: {} });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <section className="card" aria-labelledby="reps-heading">
      <div className="card-header row">
        <h2 id="reps-heading">Course reps</h2>
        <span className="spacer" />
        {canNominate ? (
          <Button variant="secondary" size="sm" onClick={() => setAdding('nominate')}>
            Nominate a student
          </Button>
        ) : null}
        {canAssign ? (
          <Button size="sm" onClick={() => setAdding('appoint')}>
            Appoint course rep
          </Button>
        ) : null}
      </div>
      <div className="card-body">
        <p className="secondary-text" style={{ margin: 0 }}>
          A course rep must be enrolled in this section. Lecturers nominate; an administrator appoints or
          approves. Dropping the student&apos;s enrolment ends the role.
        </p>
      </div>
      {reps.isError ? <Alert tone="error">{describeError(reps.error)}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Status</th>
              <th scope="col">Details</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(reps.data?.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  {reps.isPending ? 'Loading…' : 'No course reps or nominations yet.'}
                </td>
              </tr>
            ) : (
              reps.data!.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.student.fullName} <span className="muted">({r.student.studentNumber})</span>
                  </td>
                  <td>
                    <StatusBadge tone={REP_STATUS[r.status].tone} label={REP_STATUS[r.status].label} />
                  </td>
                  <td className="secondary-text">
                    {r.status === 'NOMINATED' ? (r.nominationNote ?? 'Nominated by a lecturer') : null}
                    {r.status === 'ACTIVE' ? `Since ${formatDateTime(r.startsAt)}` : null}
                    {r.endReason ? r.endReason : null}
                  </td>
                  <td>
                    {canAssign ? (
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        {r.status === 'NOMINATED' ? (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => approve(r)}>
                              Approve
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeciding({ rep: r, action: 'reject' })}
                            >
                              Reject
                            </Button>
                          </>
                        ) : null}
                        {r.status === 'ACTIVE' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeciding({ rep: r, action: 'end' })}
                          >
                            End role
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
      <EntityDialog
        title={adding === 'nominate' ? 'Nominate a course rep' : 'Appoint a course rep'}
        open={adding !== null}
        fields={[
          {
            key: 'studentId',
            label: 'Enrolled student',
            type: 'select',
            required: true,
            hint: roster.isPending ? 'Loading the enrolled students…' : undefined,
            options: (roster.data?.students ?? [])
              .filter((s) => !open.has(s.studentId))
              .map((s) => ({ value: s.studentId, label: `${s.fullName} (${s.studentNumber})` })),
          },
          adding === 'nominate'
            ? { key: 'note', label: 'Why this student? (optional, shown to the administrator)' }
            : { key: 'reason', label: 'Note for the audit log (optional)' },
        ]}
        initial={{ studentId: '', note: '', reason: '' }}
        submitLabel={adding === 'nominate' ? 'Nominate' : 'Appoint'}
        onSubmit={async (f) => {
          const extra =
            adding === 'nominate'
              ? { note: String(f.note).trim() || undefined }
              : { reason: String(f.reason).trim() || undefined };
          const path = adding === 'nominate' ? 'course-rep-nominations' : 'course-reps';
          await auth.call(`/course-sections/${sectionId}/${path}`, {
            method: 'POST',
            body: { studentId: f.studentId, ...extra },
          });
          await refresh();
        }}
        onClose={() => setAdding(null)}
      />
      <ReasonDialog
        open={deciding !== null}
        title={deciding?.action === 'reject' ? 'Reject nomination' : 'End course-rep role'}
        description="The reason is recorded in the audit log and shown on this page."
        confirmLabel={deciding?.action === 'reject' ? 'Reject' : 'End role'}
        destructive
        onConfirm={async (reason) => {
          await auth.call(`/course-reps/${deciding!.rep.id}/${deciding!.action}`, {
            method: 'POST',
            body: { reason },
          });
          await refresh();
        }}
        onClose={() => setDeciding(null)}
      />
    </section>
  );
}
