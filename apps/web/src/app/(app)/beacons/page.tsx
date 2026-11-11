'use client';

import { BEACON_PROTOCOLS, SURVEY_POSITIONS } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface Room {
  id: string;
  code: string;
  name: string;
  building: { name: string };
}
interface Beacon {
  id: string;
  label: string;
  protocol: (typeof BEACON_PROTOCOLS)[number];
  identifier: string;
  hasRotationKey: boolean;
  thresholdRssi: number | null;
  calibratedAt: string | null;
  status: 'ACTIVE' | 'SUSPECTED_FAULTY' | 'INACTIVE';
  batteryPercent: number | null;
  version: number;
}
interface Calibration {
  beaconId: string;
  phoneModels: number;
  weakestInside: number | null;
  strongestOutside: number | null;
  thresholdRssi: number | null;
  problem: string | null;
}
interface Survey {
  id: string;
  surveyedAt: string;
  notes: string | null;
  result: Calibration[];
  appliedAt: string | null;
}

const PROTOCOL_LABELS: Record<(typeof BEACON_PROTOCOLS)[number], string> = {
  EDDYSTONE_EID: 'Eddystone-EID (rotating, recommended)',
  VENDOR_ROTATING: 'Vendor rotating ID',
  EDDYSTONE_UID: 'Eddystone-UID (fixed, trials only)',
  IBEACON: 'iBeacon (fixed, trials only)',
};
const POSITION_LABELS: Record<(typeof SURVEY_POSITIONS)[number], string> = {
  INSIDE_FRONT: 'Inside: front',
  INSIDE_MIDDLE: 'Inside: middle',
  INSIDE_BACK_ROW: 'Inside: back row',
  INSIDE_CORNER: 'Inside: corner',
  DOORWAY: 'Doorway',
  CORRIDOR: 'Corridor',
  NEIGHBOUR_ROOM: 'Room next door',
  OUTSIDE_BUILDING: 'Outside the building',
};
const PROBLEMS: Record<string, string> = {
  NOT_ENOUGH_PHONES: 'Needs readings from at least three phone models.',
  NO_INSIDE_READINGS: 'No readings inside the room.',
  NO_OUTSIDE_READINGS: 'No readings outside the room.',
  OVERLAP: 'Inside and outside readings overlap: add a beacon or move it, then measure again.',
};
const STATUS = {
  ACTIVE: { label: 'Active', tone: 'success' },
  SUSPECTED_FAULTY: { label: 'Suspected faulty', tone: 'error' },
  INACTIVE: { label: 'Switched off', tone: 'neutral' },
} as const;

export default function BeaconsPage() {
  return (
    <PermissionGate permission="beacons.manage">
      <Beacons />
    </PermissionGate>
  );
}

/** Classroom beacons and their calibration (PRESENCE_VERIFICATION.md §3). */
function Beacons() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const rooms = useQuery({ queryKey: ['classrooms'], queryFn: () => auth.call<Room[]>('/classrooms') });
  const [roomId, setRoomId] = useState('');
  const beacons = useQuery({
    queryKey: ['beacons', roomId],
    enabled: Boolean(roomId),
    queryFn: () => auth.call<{ data: Beacon[] }>(`/beacons?classroomId=${roomId}`),
  });
  const surveys = useQuery({
    queryKey: ['calibration-surveys', roomId],
    enabled: Boolean(roomId),
    queryFn: () => auth.call<{ data: Survey[] }>(`/calibration-surveys?classroomId=${roomId}`),
  });
  const [dialog, setDialog] = useState<'add' | 'survey' | { edit: Beacon } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['beacons'] }),
      queryClient.invalidateQueries({ queryKey: ['calibration-surveys'] }),
    ]);
  const label = (beaconId: string) => beacons.data?.data.find((b) => b.id === beaconId)?.label ?? 'Beacon';

  async function apply(survey: Survey) {
    setError(null);
    setNotice(null);
    try {
      await auth.call(`/calibration-surveys/${survey.id}/apply`, { method: 'POST', body: {} });
      setNotice('Thresholds set from the survey.');
      await refresh();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Beacons"
        subtitle="The Bluetooth beacons in each classroom, and the surveys that set how strong a signal means “inside the room”."
        actions={
          roomId ? (
            <div className="row">
              <Button
                variant="secondary"
                onClick={() => setDialog('survey')}
                disabled={!beacons.data?.data.length}
              >
                Enter a survey
              </Button>
              <Button onClick={() => setDialog('add')}>Add a beacon</Button>
            </div>
          ) : null
        }
      />
      <SelectField
        label="Classroom"
        name="classroom"
        value={roomId}
        onChange={setRoomId}
        placeholder={rooms.isPending ? 'Loading…' : 'Choose a classroom'}
        options={(rooms.data ?? []).map((r) => ({
          value: r.id,
          label: `${r.code} · ${r.name} (${r.building.name})`,
        }))}
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {roomId && beacons.isPending ? <LoadingState /> : null}
      {beacons.isError ? <Alert tone="error">{describeError(beacons.error)}</Alert> : null}
      {beacons.data ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Beacon</th>
                <th scope="col">Type</th>
                <th scope="col">Threshold</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {beacons.data.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No beacons in this room yet.
                  </td>
                </tr>
              ) : (
                beacons.data.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.label}
                      <div className="muted">{b.identifier}</div>
                    </td>
                    <td>{PROTOCOL_LABELS[b.protocol]}</td>
                    <td>
                      {b.thresholdRssi !== null ? `${b.thresholdRssi} dBm` : 'Not calibrated'}
                      <div className="muted">{b.calibratedAt ? formatDateTime(b.calibratedAt) : ''}</div>
                    </td>
                    <td>
                      <StatusBadge tone={STATUS[b.status].tone} label={STATUS[b.status].label} />
                      {b.batteryPercent !== null ? (
                        <div className="muted">Battery {b.batteryPercent}%</div>
                      ) : null}
                    </td>
                    <td>
                      <Button size="sm" variant="secondary" onClick={() => setDialog({ edit: b })}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {surveys.data && surveys.data.data.length > 0 ? (
        <section className="card" aria-labelledby="surveys-heading">
          <div className="card-header">
            <h2 id="surveys-heading">Calibration surveys</h2>
          </div>
          <div className="card-body stack">
            {surveys.data.data.map((s) => (
              <div key={s.id} className="stack-sm">
                <div className="row">
                  <strong>{formatDateTime(s.surveyedAt)}</strong>
                  {s.appliedAt ? (
                    <StatusBadge tone="success" label={`Applied ${formatDateTime(s.appliedAt)}`} />
                  ) : s.result.every((r) => !r.problem) ? (
                    <Button size="sm" onClick={() => void apply(s)}>
                      Apply thresholds
                    </Button>
                  ) : (
                    <StatusBadge tone="error" label="Cannot be applied" />
                  )}
                </div>
                <ul className="secondary-text">
                  {s.result.map((r) => (
                    <li key={r.beaconId}>
                      {label(r.beaconId)}: {r.phoneModels} phone models; weakest inside{' '}
                      {r.weakestInside ?? '—'} dBm, strongest outside {r.strongestOutside ?? '—'} dBm →{' '}
                      {r.thresholdRssi !== null ? (
                        <strong>threshold {r.thresholdRssi} dBm</strong>
                      ) : (
                        (PROBLEMS[r.problem ?? ''] ?? r.problem)
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {dialog === 'add' ? (
        <AddBeacon roomId={roomId} onClose={() => setDialog(null)} onDone={refresh} />
      ) : null}
      {dialog === 'survey' && beacons.data ? (
        <SurveyDialog
          roomId={roomId}
          beacons={beacons.data.data}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      ) : null}
      {dialog && typeof dialog === 'object' ? (
        <EditBeacon
          beacon={dialog.edit}
          rooms={rooms.data ?? []}
          roomId={roomId}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      ) : null}
    </div>
  );
}

function AddBeacon(props: { roomId: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const auth = useAuth();
  const [label, setLabel] = useState('');
  const [protocol, setProtocol] = useState<string>('EDDYSTONE_EID');
  const [identifier, setIdentifier] = useState('');
  const [rotationKey, setRotationKey] = useState('');
  const [exponent, setExponent] = useState('10');
  const rotating = protocol === 'EDDYSTONE_EID' || protocol === 'VENDOR_ROTATING';
  return (
    <FormDialog
      open
      title="Add a beacon"
      description="Rotating-ID beacons are preferred: a copy of their signal made yesterday is useless today. The key is stored encrypted and never shown again."
      submitLabel="Add beacon"
      validate={() =>
        label.trim().length < 2
          ? 'Say where the beacon is.'
          : !identifier.trim()
            ? 'Enter the identifier.'
            : rotating && !/^[0-9a-fA-F]{32}$/.test(rotationKey)
              ? 'The rotating key is 32 hex characters.'
              : null
      }
      onSubmit={async () => {
        await auth.call('/beacons', {
          method: 'POST',
          body: {
            classroomId: props.roomId,
            label: label.trim(),
            protocol,
            identifier: identifier.trim(),
            ...(rotating ? { rotationKey } : {}),
            ...(protocol === 'EDDYSTONE_EID' ? { rotationExponent: Number(exponent) } : {}),
          },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field
        label="Where it is"
        name="label"
        value={label}
        onChange={setLabel}
        hint="For example: front wall, above the board."
      />
      <SelectField
        label="Type"
        name="protocol"
        value={protocol}
        onChange={setProtocol}
        options={BEACON_PROTOCOLS.map((p) => ({ value: p, label: PROTOCOL_LABELS[p] }))}
      />
      <Field
        label={rotating ? 'Serial number' : 'Identifier'}
        name="identifier"
        value={identifier}
        onChange={setIdentifier}
        hint={
          protocol === 'EDDYSTONE_UID'
            ? '32 hex characters'
            : protocol === 'IBEACON'
              ? 'uuid:major:minor'
              : undefined
        }
      />
      {rotating ? (
        <Field
          label="Rotating key (32 hex characters)"
          name="rotationKey"
          value={rotationKey}
          onChange={setRotationKey}
        />
      ) : null}
      {protocol === 'EDDYSTONE_EID' ? (
        <Field
          label="Rotation exponent (0–15)"
          name="exponent"
          inputMode="numeric"
          value={exponent}
          onChange={setExponent}
        />
      ) : null}
    </FormDialog>
  );
}

function EditBeacon(props: {
  beacon: Beacon;
  rooms: Room[];
  roomId: string;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [label, setLabel] = useState(props.beacon.label);
  const [classroomId, setClassroomId] = useState(props.roomId);
  const [status, setStatus] = useState(props.beacon.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE');
  const [battery, setBattery] = useState(props.beacon.batteryPercent?.toString() ?? '');
  const [reason, setReason] = useState('');
  const needsReason =
    classroomId !== props.roomId || (status === 'INACTIVE' && props.beacon.status !== 'INACTIVE');
  return (
    <FormDialog
      open
      title="Edit beacon"
      description="Moving a beacon to another room clears its threshold: survey it again where it now hangs."
      submitLabel="Save"
      validate={() =>
        needsReason && reason.trim().length < 5
          ? 'Give a reason for moving or switching off the beacon.'
          : battery && !/^\d{1,3}$/.test(battery)
            ? 'Battery is a percentage.'
            : null
      }
      onSubmit={async () => {
        await auth.call(`/beacons/${props.beacon.id}`, {
          method: 'PATCH',
          headers: { 'If-Match': String(props.beacon.version) },
          body: {
            label: label.trim(),
            ...(classroomId !== props.roomId ? { classroomId } : {}),
            status,
            ...(battery ? { batteryPercent: Number(battery) } : {}),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      <Field label="Where it is" name="label" value={label} onChange={setLabel} />
      <SelectField
        label="Classroom"
        name="classroomId"
        value={classroomId}
        onChange={setClassroomId}
        options={props.rooms.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }))}
      />
      <SelectField
        label="Status"
        name="status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'ACTIVE', label: 'Active' },
          { value: 'INACTIVE', label: 'Switched off' },
        ]}
      />
      <Field label="Battery (%)" name="battery" inputMode="numeric" value={battery} onChange={setBattery} />
      <Field
        label="Reason (needed to move or switch off)"
        name="reason"
        multiline
        value={reason}
        onChange={setReason}
        maxLength={500}
      />
    </FormDialog>
  );
}

interface Row {
  beaconId: string;
  phoneModel: string;
  platform: string;
  position: string;
  rssi: string;
}

/** Readings typed in from a walk around the room (the phone's survey mode sends the same). */
function SurveyDialog(props: {
  roomId: string;
  beacons: Beacon[];
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const blank = (): Row => ({
    beaconId: props.beacons[0]!.id,
    phoneModel: '',
    platform: 'ANDROID',
    position: 'INSIDE_FRONT',
    rssi: '',
  });
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [notes, setNotes] = useState('');
  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <FormDialog
      open
      title="Enter a calibration survey"
      description="For each reading: which beacon, which phone, where you stood, and the signal strength (a negative number in dBm). Use at least three phone models, inside the room and outside it (doorway, corridor, next room)."
      submitLabel="Save survey"
      validate={() => {
        const bad = rows.findIndex(
          (r) => r.phoneModel.trim().length < 2 || !/^-\d{1,3}$/.test(r.rssi.trim()),
        );
        return bad >= 0 ? `Reading ${bad + 1}: enter the phone model and a negative signal strength.` : null;
      }}
      onSubmit={async () => {
        await auth.call('/calibration-surveys', {
          method: 'POST',
          body: {
            classroomId: props.roomId,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            measurements: rows.map((r) => ({
              beaconId: r.beaconId,
              phoneModel: r.phoneModel.trim(),
              platform: r.platform,
              position: r.position,
              rssi: Number(r.rssi.trim()),
            })),
          },
        });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      {rows.map((r, i) => (
        <fieldset key={i} className="row">
          <legend className="visually-hidden">Reading {i + 1}</legend>
          <SelectField
            label="Beacon"
            name={`beacon-${i}`}
            value={r.beaconId}
            onChange={(v) => set(i, { beaconId: v })}
            options={props.beacons.map((b) => ({ value: b.id, label: b.label }))}
          />
          <Field
            label="Phone model"
            name={`phone-${i}`}
            value={r.phoneModel}
            onChange={(v) => set(i, { phoneModel: v })}
          />
          <SelectField
            label="Phone type"
            name={`platform-${i}`}
            value={r.platform}
            onChange={(v) => set(i, { platform: v })}
            options={[
              { value: 'ANDROID', label: 'Android' },
              { value: 'IOS', label: 'iPhone' },
            ]}
          />
          <SelectField
            label="Where"
            name={`position-${i}`}
            value={r.position}
            onChange={(v) => set(i, { position: v })}
            options={SURVEY_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] }))}
          />
          <Field
            label="Signal (dBm)"
            name={`rssi-${i}`}
            value={r.rssi}
            onChange={(v) => set(i, { rssi: v })}
          />
        </fieldset>
      ))}
      <div className="row">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setRows((rs) => [...rs, { ...rs[rs.length - 1]!, rssi: '' }])}
        >
          Add a reading
        </Button>
        {rows.length > 1 ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setRows((rs) => rs.slice(0, -1))}>
            Remove the last reading
          </Button>
        ) : null}
      </div>
      <Field
        label="Notes (optional)"
        name="notes"
        multiline
        value={notes}
        onChange={setNotes}
        maxLength={500}
      />
    </FormDialog>
  );
}
