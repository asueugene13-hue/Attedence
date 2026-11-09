'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { SelectField, StatusBadge, useAcademicOptions } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  ENROLLMENT_STATUS_LABELS,
  type EnrollmentView,
  type Offering,
  STUDENT_STATUS_LABELS,
  type StudentStatus,
  type StudentView,
  studentTone,
} from '@/lib/records';
import type { Page } from '@/lib/types';

export default function StudentPage() {
  return (
    <PermissionGate permission="students.read_full">
      <Suspense fallback={<LoadingState />}>
        <StudentDetail />
      </Suspense>
    </PermissionGate>
  );
}

const REGISTERED_NOTICE: Record<string, { tone: 'success' | 'warning' | 'info'; text: string }> = {
  sent: { tone: 'success', text: 'Student registered. An activation email was sent.' },
  failed: {
    tone: 'warning',
    text: 'Student registered, but the activation email could not be sent. Resend it from Accounts once email works.',
  },
  existing: {
    tone: 'info',
    text: 'Student registered on their existing account, which now also holds the Student role. No activation email was needed.',
  },
};

function StudentDetail() {
  const auth = useAuth();
  const { id } = useParams<{ id: string }>();
  const registered = useSearchParams().get('registered');
  const query = useQuery({
    queryKey: ['student', id],
    queryFn: () => auth.call<StudentView>(`/students/${id}`),
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <Alert tone="error">{describeError(query.error)}</Alert>;
  const student = query.data;
  const notice = registered ? REGISTERED_NOTICE[registered] : undefined;

  return (
    <div className="stack">
      <PageHeader
        title={student.fullName}
        subtitle={`Student ID ${student.studentNumber} · ${student.programme.code} · ${student.level.name}`}
        actions={
          <Link className="btn btn-secondary" href="/students">
            All students
          </Link>
        }
      />
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
        <div className="stack" style={{ flex: '2 1 420px' }}>
          <DetailsCard student={student} />
          <EnrolmentsCard student={student} />
        </div>
        <div className="stack" style={{ flex: '1 1 260px' }}>
          <StatusCard student={student} />
          <PhotoCard student={student} />
        </div>
      </div>
    </div>
  );
}

/** Refreshes this student everywhere it is shown after a change. */
function useRefreshStudent(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['student', id] }),
      queryClient.invalidateQueries({ queryKey: ['students'] }),
    ]);
}

function DetailsCard({ student }: { student: StudentView }) {
  const auth = useAuth();
  const academic = useAcademicOptions();
  const refresh = useRefreshStudent(student.id);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = () => ({
    fullName: student.fullName,
    phone: student.phone ?? '',
    programmeId: student.programme.id,
    levelId: student.level.id,
    academicYearId: student.academicYear.id,
    semesterId: student.semester.id,
    noDeviceExemption: student.noDeviceExemption,
  });
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (!editing) setForm(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the saved record changes
  }, [student.version, editing]);

  const year = academic.years.find((y) => y.id === form.academicYearId);
  const canEdit = auth.can('students.update');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.call(`/students/${student.id}`, {
        method: 'PATCH',
        body: form,
        headers: { 'If-Match': String(student.version) },
      });
      await refresh();
      setEditing(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <section className="card" aria-labelledby="details-heading">
        <div className="card-header row">
          <h2 id="details-heading">Details</h2>
          <span className="spacer" />
          {canEdit ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </div>
        <dl
          className="card-body"
          style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 24px', margin: 0 }}
        >
          <dt className="muted">Email</dt>
          <dd style={{ margin: 0 }}>{student.email}</dd>
          <dt className="muted">Phone</dt>
          <dd style={{ margin: 0 }}>{student.phone ?? '—'}</dd>
          <dt className="muted">Programme</dt>
          <dd style={{ margin: 0 }}>
            {student.programme.code} · {student.programme.name}
          </dd>
          <dt className="muted">Department</dt>
          <dd style={{ margin: 0 }}>{student.department.name}</dd>
          <dt className="muted">Faculty</dt>
          <dd style={{ margin: 0 }}>{student.faculty.name}</dd>
          <dt className="muted">Level</dt>
          <dd style={{ margin: 0 }}>{student.level.name}</dd>
          <dt className="muted">Current semester</dt>
          <dd style={{ margin: 0 }}>
            {student.academicYear.label} · {student.semester.name}
          </dd>
          <dt className="muted">No compatible phone</dt>
          <dd style={{ margin: 0 }}>
            {student.noDeviceExemption ? 'Yes: the lecturer checks this student in' : 'No'}
          </dd>
          <dt className="muted">Account</dt>
          <dd style={{ margin: 0 }}>
            {student.accountStatus === 'PENDING_ACTIVATION'
              ? 'Awaiting activation'
              : student.accountStatus.toLowerCase()}
          </dd>
        </dl>
      </section>
    );
  }

  return (
    <form className="card card-body stack" onSubmit={save} noValidate aria-label="Edit student details">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Field
          label="Full name"
          name="fullName"
          required
          value={form.fullName}
          onChange={(fullName) => setForm((f) => ({ ...f, fullName }))}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          value={form.phone}
          onChange={(phone) => setForm((f) => ({ ...f, phone }))}
        />
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <SelectField
          label="Programme"
          name="programmeId"
          value={form.programmeId}
          onChange={(programmeId) => setForm((f) => ({ ...f, programmeId }))}
          options={academic.programmes.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
        />
        <SelectField
          label="Level"
          name="levelId"
          value={form.levelId}
          onChange={(levelId) => setForm((f) => ({ ...f, levelId }))}
          options={academic.levels.map((l) => ({ value: l.id, label: l.name }))}
        />
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <SelectField
          label="Academic year"
          name="academicYearId"
          value={form.academicYearId}
          onChange={(academicYearId) => setForm((f) => ({ ...f, academicYearId, semesterId: '' }))}
          options={academic.years.map((y) => ({ value: y.id, label: y.label }))}
        />
        <SelectField
          label="Semester"
          name="semesterId"
          value={form.semesterId}
          placeholder="Choose a semester"
          onChange={(semesterId) => setForm((f) => ({ ...f, semesterId }))}
          options={(year?.semesters ?? [])
            .filter((s) => s.status !== 'CLOSED')
            .map((s) => ({ value: s.id, label: s.name }))}
        />
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.noDeviceExemption}
          onChange={(e) => setForm((f) => ({ ...f, noDeviceExemption: e.target.checked }))}
        />
        No compatible phone: the lecturer checks this student in
      </label>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="row">
        <Button type="button" variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </Button>
        <span className="spacer" />
        <Button type="submit" busy={busy} busyLabel="Saving…">
          Save changes
        </Button>
      </div>
    </form>
  );
}

function StatusCard({ student }: { student: StudentView }) {
  const auth = useAuth();
  const refresh = useRefreshStudent(student.id);
  const [nextStatus, setNextStatus] = useState<StudentStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const canEdit = auth.can('students.update');

  async function verify() {
    setVerifying(true);
    setError(null);
    try {
      await auth.call(`/students/${student.id}/verify`, {
        method: 'POST',
        body: {},
        headers: { 'If-Match': String(student.version) },
      });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <section className="card" aria-labelledby="status-heading">
      <div className="card-header">
        <h2 id="status-heading">Status</h2>
      </div>
      <div className="card-body stack">
        <div className="row">
          <StatusBadge tone={studentTone(student.status)} label={STUDENT_STATUS_LABELS[student.status]} />
          {student.verifiedAt ? (
            <StatusBadge tone="success" label={`Verified ${formatDateTime(student.verifiedAt)}`} />
          ) : (
            <StatusBadge tone="warning" label="Not verified" />
          )}
        </div>
        {canEdit ? (
          <>
            <SelectField
              label="Change academic status"
              name="nextStatus"
              value={nextStatus}
              placeholder="Choose a new status"
              onChange={(v) => setNextStatus(v as StudentStatus | '')}
              options={Object.entries(STUDENT_STATUS_LABELS)
                .filter(([value]) => value !== student.status)
                .map(([value, label]) => ({ value, label }))}
            />
            {!student.verifiedAt ? (
              <Button variant="secondary" busy={verifying} onClick={verify}>
                Mark record as verified
              </Button>
            ) : null}
          </>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
      <ReasonDialog
        open={nextStatus !== ''}
        title={`Change status to ${nextStatus ? STUDENT_STATUS_LABELS[nextStatus] : ''}`}
        description="Status changes affect what the student can do in AttendSure. The reason is recorded in the audit log."
        confirmLabel="Change status"
        onConfirm={async (reason) => {
          await auth.call(`/students/${student.id}/status`, {
            method: 'POST',
            body: { status: nextStatus, reason },
            headers: { 'If-Match': String(student.version) },
          });
          await refresh();
        }}
        onClose={() => setNextStatus('')}
      />
    </section>
  );
}

function PhotoCard({ student }: { student: StudentView }) {
  const auth = useAuth();
  const refresh = useRefreshStudent(student.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const photo = useQuery({
    queryKey: ['student-photo', student.id, student.version],
    enabled: student.hasPhoto,
    // The link works for 5 minutes; fetch a fresh one well before that.
    staleTime: 4 * 60_000,
    queryFn: () => auth.call<{ url: string }>(`/students/${student.id}/photo`),
  });
  const canEdit = auth.can('students.update');

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('photo', file);
      await auth.call(`/students/${student.id}/photo`, {
        method: 'POST',
        body,
        headers: { 'If-Match': String(student.version) },
      });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="photo-heading">
      <div className="card-header">
        <h2 id="photo-heading">Photo</h2>
      </div>
      <div className="card-body stack">
        {student.hasPhoto && photo.data ? (
          // A plain <img>: the source is a short-lived private link, not a static asset to optimise.
          <img
            src={photo.data.url}
            alt={`Photo of ${student.fullName}`}
            style={{ maxWidth: 200, borderRadius: 8 }}
          />
        ) : (
          <p className="muted">{student.hasPhoto ? 'Loading photo…' : 'No photo yet.'}</p>
        )}
        {photo.isError ? <Alert tone="error">{describeError(photo.error)}</Alert> : null}
        {canEdit ? (
          <>
            <div className="field">
              <label htmlFor="photo-file">{student.hasPhoto ? 'Replace photo' : 'Add photo'}</label>
              <input
                id="photo-file"
                type="file"
                accept="image/jpeg,image/png"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(file);
                }}
              />
              <span className="field-hint">JPEG or PNG, up to 2 MB.</span>
            </div>
            {student.hasPhoto ? (
              <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
                Remove photo
              </Button>
            ) : null}
          </>
        ) : null}
        {busy ? <p className="muted">Uploading…</p> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
      <ReasonDialog
        open={removing}
        title="Remove photo"
        description="The stored photo is deleted. The reason is recorded in the audit log."
        confirmLabel="Remove photo"
        destructive
        onConfirm={async (reason) => {
          await auth.call(`/students/${student.id}/photo`, {
            method: 'DELETE',
            body: { reason },
            headers: { 'If-Match': String(student.version) },
          });
          await refresh();
        }}
        onClose={() => setRemoving(false)}
      />
    </section>
  );
}

function EnrolmentsCard({ student }: { student: StudentView }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canManage = auth.can('enrollments.manage');
  const enrolments = useQuery({
    queryKey: ['enrollments', { studentId: student.id }],
    enabled: canManage,
    queryFn: () => auth.call<Page<EnrollmentView>>(`/enrollments?studentId=${student.id}&limit=200`),
  });
  const offerings = useQuery({
    queryKey: ['offerings', student.semester.id],
    enabled: canManage,
    queryFn: () => auth.call<Offering[]>(`/course-offerings?semesterId=${student.semester.id}`),
  });
  const [sectionId, setSectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<EnrollmentView | null>(null);
  // Enrolling or dropping also changes section rosters, and a drop can end a course-rep role.
  const refresh = () =>
    Promise.all(
      [['enrollments'], ['roster'], ['course-reps']].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );

  if (!canManage) return null;

  const sectionOptions = (offerings.data ?? [])
    .filter((o) => o.status !== 'CLOSED')
    .flatMap((o) =>
      o.sections
        .filter((s) => s.isActive)
        .map((s) => ({ value: s.id, label: `${o.course.code} ${o.course.title} · section ${s.code}` })),
    );

  async function enrol(event: React.FormEvent) {
    event.preventDefault();
    if (!sectionId) return;
    setBusy(true);
    setError(null);
    try {
      await auth.call('/enrollments', { method: 'POST', body: { studentId: student.id, sectionId } });
      setSectionId('');
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const rows = enrolments.data?.data ?? [];
  return (
    <section className="card" aria-labelledby="enrolments-heading">
      <div className="card-header">
        <h2 id="enrolments-heading">Enrolments</h2>
      </div>
      <div className="card-body stack">
        {enrolments.isError ? <Alert tone="error">{describeError(enrolments.error)}</Alert> : null}
        {enrolments.isPending ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <p className="muted">Not enrolled in any course yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Course</th>
                  <th scope="col">Section</th>
                  <th scope="col">Semester</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.course.code} · {e.course.title}
                    </td>
                    <td>{e.section.code}</td>
                    <td className="secondary-text">{e.semester.name}</td>
                    <td>
                      <StatusBadge
                        tone={e.status === 'ENROLLED' ? 'success' : 'neutral'}
                        label={ENROLLMENT_STATUS_LABELS[e.status]}
                      />
                      {e.endReason ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {e.endReason}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {e.status === 'ENROLLED' ? (
                        <Button variant="ghost" size="sm" onClick={() => setEnding(e)}>
                          Drop
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="row" onSubmit={enrol} aria-label="Enrol in a course">
          <SelectField
            label={`Enrol in a course · ${student.semester.name}`}
            name="sectionId"
            value={sectionId}
            onChange={setSectionId}
            placeholder={
              sectionOptions.length ? 'Choose a course section' : 'No open course sections this semester'
            }
            options={sectionOptions}
          />
          <Button
            type="submit"
            variant="secondary"
            busy={busy}
            disabled={!sectionId}
            style={{ alignSelf: 'flex-end' }}
          >
            Enrol
          </Button>
        </form>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
      <ReasonDialog
        open={ending !== null}
        title={ending ? `Drop ${ending.course.code}` : 'Drop'}
        description="The enrolment is kept as history and the student can be enrolled again later. A course-rep role for that section ends with it."
        confirmLabel="Drop enrolment"
        destructive
        onConfirm={async (reason) => {
          await auth.call(`/enrollments/${ending!.id}/end`, {
            method: 'POST',
            body: { status: 'DROPPED', reason },
          });
          await refresh();
        }}
        onClose={() => setEnding(null)}
      />
    </section>
  );
}
