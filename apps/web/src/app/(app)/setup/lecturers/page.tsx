'use client';

import { useQuery } from '@tanstack/react-query';
import { EntityManager, orNull, text } from '@/components/entity-manager';
import { PermissionGate } from '@/components/permission-gate';
import { StatusBadge } from '@/components/records';
import { PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';

interface Lecturer {
  id: string;
  staffNumber: string;
  title: string | null;
  status: 'ACTIVE' | 'ON_LEAVE' | 'INACTIVE';
  user: { id: string; email: string; fullName: string; status: string };
  department: { id: string; code: string; name: string };
}
interface Department {
  id: string;
  name: string;
}

const STATUS = {
  ACTIVE: { label: 'Active', tone: 'success' },
  ON_LEAVE: { label: 'On leave', tone: 'warning' },
  INACTIVE: { label: 'Inactive', tone: 'neutral' },
} as const;

export default function LecturersPage() {
  return (
    <PermissionGate permission="academic_structure.read">
      <Lecturers />
    </PermissionGate>
  );
}

function Lecturers() {
  const auth = useAuth();
  const departments = useQuery({
    queryKey: ['departments', false],
    queryFn: () => auth.call<Department[]>('/departments'),
  });
  const departmentOptions = (departments.data ?? []).map((d) => ({ value: d.id, label: d.name }));

  return (
    <div className="stack">
      <PageHeader
        title="Lecturers"
        subtitle="Lecturer profiles. Adding a lecturer with a new email creates an account and sends an activation email; an existing account (for example an administrator who also teaches) gains the Lecturer role instead."
      />
      <EntityManager<Lecturer>
        title="All lecturers"
        noun="lecturer"
        description="The staff-number format is still to be confirmed by the university (decision D-14); any letters, digits, / - or _ are accepted for now."
        listPath="/lecturers"
        queryKey={['lecturers']}
        managePermission="lecturers.manage"
        columns={[
          { header: 'Staff number', cell: (r) => r.staffNumber },
          { header: 'Name', cell: (r) => [r.title, r.user.fullName].filter(Boolean).join(' ') },
          { header: 'Email', cell: (r) => <span className="secondary-text">{r.user.email}</span> },
          { header: 'Department', cell: (r) => r.department.name },
          {
            header: 'Status',
            cell: (r) => <StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} />,
          },
        ]}
        fields={[
          { key: 'fullName', label: 'Full name', required: true, createOnly: true },
          {
            key: 'email',
            label: 'Email',
            required: true,
            createOnly: true,
            hint: 'The activation link is sent here.',
          },
          { key: 'staffNumber', label: 'Staff number', required: true, maxLength: 30 },
          {
            key: 'departmentId',
            label: 'Department',
            type: 'select',
            required: true,
            options: departmentOptions,
          },
          { key: 'title', label: 'Title', hint: 'For example Dr or Prof. Optional.' },
          {
            key: 'status',
            label: 'Status',
            type: 'select',
            required: true,
            editOnly: true,
            options: Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label })),
          },
        ]}
        emptyForm={{
          fullName: '',
          email: '',
          staffNumber: '',
          departmentId: '',
          title: '',
          status: 'ACTIVE',
        }}
        toForm={(r) => ({
          staffNumber: r.staffNumber,
          departmentId: r.department.id,
          title: r.title ?? '',
          status: r.status,
        })}
        toBody={(f, mode) =>
          mode === 'create'
            ? {
                fullName: text(f.fullName),
                email: text(f.email),
                staffNumber: text(f.staffNumber),
                departmentId: f.departmentId,
                title: text(f.title),
              }
            : {
                staffNumber: text(f.staffNumber),
                departmentId: f.departmentId,
                title: orNull(text(f.title), mode),
                status: f.status,
              }
        }
        createPath="/lecturers"
        updatePath={(r) => `/lecturers/${r.id}`}
      />
    </div>
  );
}
