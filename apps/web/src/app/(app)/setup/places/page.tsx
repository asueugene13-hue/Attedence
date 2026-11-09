'use client';

import { useQuery } from '@tanstack/react-query';
import {
  EntityManager,
  type FieldSpec,
  type FormValues,
  num,
  orNull,
  text,
} from '@/components/entity-manager';
import { PermissionGate } from '@/components/permission-gate';
import { PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';

interface Geofence {
  lat: number;
  lng: number;
  radiusM: number;
}
interface Campus {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  geofence: Geofence | null;
}
interface Building extends Campus {
  campusId: string;
}
interface Classroom {
  id: string;
  code: string;
  name: string;
  floor: string | null;
  capacity: number | null;
  isActive: boolean;
  building: { id: string; code: string; name: string };
  campus: { id: string; code: string; name: string };
  geofence: Geofence | null;
}

const CODE_HINT = 'Short code, stored in capitals.';
const geofenceFields: FieldSpec[] = [
  {
    key: 'lat',
    label: 'Geofence centre latitude',
    type: 'number',
    hint: 'From a site survey, e.g. 5.6037. Leave all three empty for none.',
  },
  { key: 'lng', label: 'Geofence centre longitude', type: 'number' },
  { key: 'radiusM', label: 'Geofence radius (metres)', type: 'number', hint: '20 to 5,000 m.' },
];
const geofenceForm = (g: Geofence | null): FormValues => ({
  lat: g ? String(g.lat) : '',
  lng: g ? String(g.lng) : '',
  radiusM: g ? String(g.radiusM) : '',
});
/** All three numbers make a geofence; none means "no geofence" (cleared when editing). */
function geofenceBody(f: FormValues, mode: 'create' | 'edit') {
  const lat = num(f.lat);
  const lng = num(f.lng);
  const radiusM = num(f.radiusM);
  if (lat === undefined && lng === undefined && radiusM === undefined) return orNull(undefined, mode);
  return { lat, lng, radiusM };
}
const describeGeofence = (g: Geofence | null) => (g ? `${g.lat}, ${g.lng} · ${g.radiusM} m` : '—');

export default function PlacesPage() {
  return (
    <PermissionGate permission="classrooms.manage">
      <Places />
    </PermissionGate>
  );
}

function Places() {
  const auth = useAuth();
  const campuses = useQuery({
    queryKey: ['campuses', false],
    queryFn: () => auth.call<Campus[]>('/campuses'),
  });
  const buildings = useQuery({
    queryKey: ['buildings', false],
    queryFn: () => auth.call<Building[]>('/buildings'),
  });
  const campusName = new Map((campuses.data ?? []).map((c) => [c.id, c.name]));

  return (
    <div className="stack">
      <PageHeader
        title="Places"
        subtitle="Campuses, buildings and classrooms. A building's geofence, when set, replaces its campus's for the rooms inside. Geofences are used from Phase 4 for classroom check-in."
      />
      <EntityManager<Campus>
        title="Campuses"
        noun="campus"
        listPath="/campuses"
        queryKey={['campuses']}
        managePermission="classrooms.manage"
        deactivatable
        columns={[
          { header: 'Code', cell: (r) => r.code },
          { header: 'Name', cell: (r) => r.name },
          { header: 'Geofence', cell: (r) => describeGeofence(r.geofence) },
        ]}
        fields={[
          { key: 'code', label: 'Code', required: true, hint: CODE_HINT, maxLength: 20 },
          { key: 'name', label: 'Name', required: true },
          ...geofenceFields,
        ]}
        emptyForm={{ code: '', name: '', ...geofenceForm(null) }}
        toForm={(r) => ({ code: r.code, name: r.name, ...geofenceForm(r.geofence) })}
        toBody={(f, mode) => ({ code: text(f.code), name: text(f.name), geofence: geofenceBody(f, mode) })}
        createPath="/campuses"
        updatePath={(r) => `/campuses/${r.id}`}
        alsoInvalidate={[['classrooms']]}
      />
      <EntityManager<Building>
        title="Buildings"
        noun="building"
        listPath="/buildings"
        queryKey={['buildings']}
        managePermission="classrooms.manage"
        deactivatable
        columns={[
          { header: 'Code', cell: (r) => r.code },
          { header: 'Name', cell: (r) => r.name },
          { header: 'Campus', cell: (r) => campusName.get(r.campusId) ?? '—' },
          { header: 'Geofence', cell: (r) => describeGeofence(r.geofence) },
        ]}
        fields={[
          {
            key: 'campusId',
            label: 'Campus',
            type: 'select',
            required: true,
            createOnly: true,
            options: (campuses.data ?? []).map((c) => ({ value: c.id, label: c.name })),
          },
          { key: 'code', label: 'Code', required: true, hint: CODE_HINT, maxLength: 20 },
          { key: 'name', label: 'Name', required: true },
          ...geofenceFields,
        ]}
        emptyForm={{ campusId: '', code: '', name: '', ...geofenceForm(null) }}
        toForm={(r) => ({ code: r.code, name: r.name, ...geofenceForm(r.geofence) })}
        toBody={(f, mode) => ({
          ...(mode === 'create' ? { campusId: f.campusId } : {}),
          code: text(f.code),
          name: text(f.name),
          geofence: geofenceBody(f, mode),
        })}
        createPath="/buildings"
        updatePath={(r) => `/buildings/${r.id}`}
        alsoInvalidate={[['classrooms']]}
      />
      <EntityManager<Classroom>
        title="Classrooms"
        noun="classroom"
        listPath="/classrooms"
        queryKey={['classrooms']}
        managePermission="classrooms.manage"
        deactivatable
        columns={[
          { header: 'Code', cell: (r) => r.code },
          { header: 'Name', cell: (r) => r.name },
          { header: 'Building', cell: (r) => `${r.building.name} (${r.campus.code})` },
          { header: 'Floor', cell: (r) => r.floor ?? '—' },
          { header: 'Seats', cell: (r) => r.capacity ?? '—' },
          { header: 'Geofence in use', cell: (r) => describeGeofence(r.geofence) },
        ]}
        fields={[
          {
            key: 'buildingId',
            label: 'Building',
            type: 'select',
            required: true,
            createOnly: true,
            options: (buildings.data ?? []).map((b) => ({
              value: b.id,
              label: `${b.name} (${campusName.get(b.campusId) ?? ''})`,
            })),
          },
          { key: 'code', label: 'Code', required: true, hint: CODE_HINT, maxLength: 20 },
          { key: 'name', label: 'Name', required: true },
          { key: 'floor', label: 'Floor', hint: 'As the building labels it. Optional.' },
          { key: 'capacity', label: 'Seats', type: 'number', hint: 'Optional.' },
        ]}
        emptyForm={{ buildingId: '', code: '', name: '', floor: '', capacity: '' }}
        toForm={(r) => ({
          code: r.code,
          name: r.name,
          floor: r.floor ?? '',
          capacity: r.capacity === null ? '' : String(r.capacity),
        })}
        toBody={(f, mode) => ({
          ...(mode === 'create' ? { buildingId: f.buildingId } : {}),
          code: text(f.code),
          name: text(f.name),
          floor: orNull(text(f.floor), mode),
          capacity: orNull(num(f.capacity), mode),
        })}
        createPath="/classrooms"
        updatePath={(r) => `/classrooms/${r.id}`}
      />
    </div>
  );
}
