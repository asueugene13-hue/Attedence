'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, useAcademicOptions } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { ApiError, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { STUDENT_STATUS_LABELS, type StudentView } from '@/lib/records';

export default function NewStudentPage() {
  return (
    <PermissionGate permission="students.create">
      <NewStudentForm />
    </PermissionGate>
  );
}

const EMPTY = {
  studentNumber: '',
  fullName: '',
  email: '',
  phone: '',
  programmeId: '',
  levelId: '',
  academicYearId: '',
  semesterId: '',
  status: 'ACTIVE',
};

function NewStudentForm() {
  const auth = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const academic = useAcademicOptions();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof EMPTY) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value, ...(key === 'academicYearId' ? { semesterId: '' } : {}) }));

  const year = academic.years.find((y) => y.id === form.academicYearId);
  const openSemesters = (year?.semesters ?? []).filter((s) => s.status !== 'CLOSED');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await auth.call<{
        student: StudentView;
        newAccount: boolean;
        activationEmailSent: boolean | null;
      }>('/students', { method: 'POST', body: form });
      await queryClient.invalidateQueries({ queryKey: ['students'] });
      const email =
        result.activationEmailSent === null ? 'existing' : result.activationEmailSent ? 'sent' : 'failed';
      router.push(`/students/${result.student.id}?registered=${email}`);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.length > 0) {
        setFieldErrors(Object.fromEntries(err.fieldErrors.map((e) => [e.field ?? '', e.message])));
      }
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (academic.isPending) return <LoadingState />;
  const missingStructure =
    academic.programmes.length === 0 || academic.levels.length === 0 || academic.years.length === 0;

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <PageHeader
        title="Register a student"
        subtitle="Creates the student record and an account. The student receives an activation email to choose a password."
      />
      {academic.error ? <Alert tone="error">{describeError(academic.error)}</Alert> : null}
      {missingStructure ? (
        <Alert tone="warning">
          Programmes, levels and academic years must be set up before students can be registered. An
          administrator enters them under Academic structure.
        </Alert>
      ) : null}
      <form className="card card-body stack" onSubmit={submit} noValidate>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Field
            label="Student ID"
            name="studentNumber"
            required
            inputMode="numeric"
            maxLength={8}
            hint="The 8-digit Student ID."
            value={form.studentNumber}
            onChange={set('studentNumber')}
            error={fieldErrors.studentNumber}
          />
          <Field
            label="Full name"
            name="fullName"
            required
            value={form.fullName}
            onChange={set('fullName')}
            error={fieldErrors.fullName}
          />
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Field
            label="Email"
            name="email"
            type="email"
            inputMode="email"
            required
            hint="The activation link is sent here."
            value={form.email}
            onChange={set('email')}
            error={fieldErrors.email}
          />
          <Field
            label="Phone"
            name="phone"
            type="tel"
            inputMode="tel"
            required
            hint="A Ghana number, e.g. 024 555 0123."
            value={form.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <SelectField
            label="Programme"
            name="programmeId"
            required
            value={form.programmeId}
            onChange={set('programmeId')}
            placeholder="Choose a programme"
            options={academic.programmes.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
          />
          <SelectField
            label="Level"
            name="levelId"
            required
            value={form.levelId}
            onChange={set('levelId')}
            placeholder="Choose a level"
            options={academic.levels.map((l) => ({ value: l.id, label: l.name }))}
          />
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <SelectField
            label="Academic year"
            name="academicYearId"
            required
            value={form.academicYearId}
            onChange={set('academicYearId')}
            placeholder="Choose a year"
            options={academic.years.map((y) => ({
              value: y.id,
              label: y.label + (y.isCurrent ? ' (current)' : ''),
            }))}
          />
          <SelectField
            label="Semester"
            name="semesterId"
            required
            disabled={!year}
            value={form.semesterId}
            onChange={set('semesterId')}
            placeholder={year ? 'Choose a semester' : 'Choose a year first'}
            options={openSemesters.map((s) => ({ value: s.id, label: s.name }))}
          />
          <SelectField
            label="Status"
            name="status"
            value={form.status}
            onChange={set('status')}
            options={Object.entries(STUDENT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="row">
          <Link className="btn btn-secondary" href="/students">
            Cancel
          </Link>
          <span className="spacer" />
          <Button type="submit" busy={busy} busyLabel="Registering…" disabled={missingStructure}>
            Register student
          </Button>
        </div>
      </form>
    </div>
  );
}
