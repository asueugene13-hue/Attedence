'use client';

import { useQuery } from '@tanstack/react-query';
import { EntityManager, num, orNull, text } from '@/components/entity-manager';
import { PermissionGate } from '@/components/permission-gate';
import { PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';

interface Faculty {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
interface Department extends Faculty {
  facultyId: string;
}
interface Programme extends Faculty {
  departmentId: string;
  qualification: string | null;
  durationYears: number | null;
}
interface Level extends Faculty {
  sortOrder: number;
}

const CODE_HINT = 'Short code, stored in capitals.';

export default function StructurePage() {
  return (
    <PermissionGate permission="academic_structure.read">
      <Structure />
    </PermissionGate>
  );
}

function Structure() {
  const auth = useAuth();
  // Active parents for the "belongs to" choices.
  const faculties = useQuery({
    queryKey: ['faculties', false],
    queryFn: () => auth.call<Faculty[]>('/faculties'),
  });
  const departments = useQuery({
    queryKey: ['departments', false],
    queryFn: () => auth.call<Department[]>('/departments'),
  });
  const facultyName = new Map((faculties.data ?? []).map((f) => [f.id, f.name]));
  const departmentName = new Map((departments.data ?? []).map((d) => [d.id, d.name]));

  return (
    <div className="stack">
      <PageHeader
        title="Academic structure"
        subtitle="Faculties, departments, programmes and levels exactly as the university names them. Nothing is deleted: records are deactivated so history keeps pointing at them."
      />

      <EntityManager<Faculty>
        title="Faculties"
        noun="faculty"
        listPath="/faculties"
        queryKey={['faculties']}
        managePermission="academic_structure.manage"
        deactivatable
        columns={[
          { header: 'Code', cell: (r) => r.code },
          { header: 'Name', cell: (r) => r.name },
        ]}
        fields={[
          { key: 'code', label: 'Code', required: true, hint: CODE_HINT, maxLength: 20 },
          { key: 'name', label: 'Name', required: true },
        ]}
        emptyForm={{ code: '', name: '' }}
        toForm={(r) => ({ code: r.code, name: r.name })}
        toBody={(f) => ({ code: text(f.code), name: text(f.name) })}
        createPath="/faculties"
        updatePath={(r) => `/faculties/${r.id}`}
      />

      <EntityManager<Department>
        title="Departments"
        noun="department"
        listPath="/departments"
        queryKey={['departments']}
        managePermission="academic_structure.manage"
        deactivatable
        columns={[
          { header: 'Code', cell: (r) => r.code },
          { header: 'Name', cell: (r) => r.name },
          { header: 'Faculty', cell: (r) => facultyName.get(r.facultyId) ?? '—' },
        ]}
        fields={[
          {
            key: 'facultyId',
            label: 'Faculty',
            type: 'select',
            required: true,
            createOnly: true,
            options: (faculties.data ?? []).map((f) => ({ value: f.id, label: f.name })),
          },
          { key: 'code', label: 'Code', required: true, hint: CODE_HINT, maxLength: 20 },
          { key: 'name', label: 'Name', required: true },
        ]}
        emptyForm={{ facultyId: '', code: '', name: '' }}
        toForm={(r) => ({ code: r.code, name: r.name })}
        toBody={(f, mode) =>
          mode === 'create'
            ? { facultyId: f.facultyId, code: text(f.code), name: text(f.name) }
            : { code: text(f.code), name: text(f.name) }
        }
        createPath="/departments"
        updatePath={(r) => `/departments/${r.id}`}
      />

      <EntityManager<Programme>
        title="Programmes"
        noun="programme"
        listPath="/programmes"
        queryKey={['programmes']}
        managePermission="academic_structure.manage"
        deactivatable
        columns={[
          { header: 'Code', cell: (r) => r.code },
          { header: 'Name', cell: (r) => r.name },
          { header: 'Department', cell: (r) => departmentName.get(r.departmentId) ?? '—' },
          { header: 'Qualification', cell: (r) => r.qualification ?? '—' },
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
          { key: 'code', label: 'Code', required: true, hint: CODE_HINT, maxLength: 20 },
          { key: 'name', label: 'Name', required: true },
          {
            key: 'qualification',
            label: 'Qualification',
            hint: 'The award, as the university states it. Optional.',
          },
          { key: 'durationYears', label: 'Duration in years', type: 'number', hint: 'Optional.' },
        ]}
        emptyForm={{ departmentId: '', code: '', name: '', qualification: '', durationYears: '' }}
        toForm={(r) => ({
          code: r.code,
          name: r.name,
          qualification: r.qualification ?? '',
          durationYears: r.durationYears === null ? '' : String(r.durationYears),
        })}
        toBody={(f, mode) => ({
          ...(mode === 'create' ? { departmentId: f.departmentId } : {}),
          code: text(f.code),
          name: text(f.name),
          qualification: orNull(text(f.qualification), mode),
          durationYears: orNull(num(f.durationYears), mode),
        })}
        createPath="/programmes"
        updatePath={(r) => `/programmes/${r.id}`}
      />

      <EntityManager<Level>
        title="Levels"
        noun="level"
        description="Year groups as the university names them. The order number sorts them in lists."
        listPath="/academic-levels"
        queryKey={['levels']}
        managePermission="academic_structure.manage"
        deactivatable
        columns={[
          { header: 'Order', cell: (r) => r.sortOrder },
          { header: 'Code', cell: (r) => r.code },
          { header: 'Name', cell: (r) => r.name },
        ]}
        fields={[
          { key: 'code', label: 'Code', required: true, hint: CODE_HINT, maxLength: 20 },
          { key: 'name', label: 'Name', required: true },
          {
            key: 'sortOrder',
            label: 'Order',
            type: 'number',
            required: true,
            hint: 'Lower numbers come first.',
          },
        ]}
        emptyForm={{ code: '', name: '', sortOrder: '' }}
        toForm={(r) => ({ code: r.code, name: r.name, sortOrder: String(r.sortOrder) })}
        toBody={(f) => ({ code: text(f.code), name: text(f.name), sortOrder: num(f.sortOrder) })}
        createPath="/academic-levels"
        updatePath={(r) => `/academic-levels/${r.id}`}
      />
    </div>
  );
}
