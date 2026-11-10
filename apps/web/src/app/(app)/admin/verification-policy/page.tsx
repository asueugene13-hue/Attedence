'use client';

import { BLE_RESULTS, GPS_RESULTS, INTEGRITY_RESULTS, type VerificationRules } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormDialog } from '@/components/form-dialog';
import { PermissionGate } from '@/components/permission-gate';
import { SelectField, StatusBadge } from '@/components/records';
import { Alert, Button, Field, LoadingState, PageHeader } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

interface PolicyVersion {
  version: number;
  rules: VerificationRules;
  reason: string | null;
  createdBy: { fullName: string } | null;
  createdAt: string | null;
}

type RuleKey = keyof VerificationRules;
const OUTCOME_LABELS: Record<string, string> = {
  VERIFIED: 'Verified',
  PENDING_VERIFICATION: 'Lecturer confirms',
  MANUAL_REVIEW_REQUIRED: 'Needs review',
  REJECTED: 'Rejected',
};

/** Each rule, in plain words, with what it may be set to (PRESENCE_VERIFICATION.md §9). */
const RULES: { key: RuleKey; label: string; help: string; options?: string[]; unit?: string }[] = [
  {
    key: 'bleRequired',
    label: 'Beacon required',
    help: 'The classroom beacon is the main evidence. Only a Super Admin can turn this off.',
    options: ['true', 'false'],
  },
  {
    key: 'bleWeakAction',
    label: 'Weak beacon signal',
    help: 'The room’s beacon was heard, but below its calibrated threshold.',
    options: ['PENDING_VERIFICATION', 'VERIFIED'],
  },
  {
    key: 'noBleGpsInsideAction',
    label: 'No beacon, GPS on campus',
    help: 'No beacon heard, but the phone’s location is on site.',
    options: ['PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED'],
  },
  {
    key: 'newDeviceAction',
    label: 'Phone not yet approved',
    help: 'Classroom evidence from a student’s new phone that is waiting for approval.',
    options: ['PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED'],
  },
  {
    key: 'integrityFailAction',
    label: 'Integrity check failed',
    help: 'The app or phone failed Play Integrity / App Attest (once these are set up).',
    options: ['PENDING_VERIFICATION', 'MANUAL_REVIEW_REQUIRED'],
  },
  {
    key: 'mockLocationAction',
    label: 'Fake location app',
    help: 'Android reported the location came from a mock-location app.',
    options: ['MANUAL_REVIEW_REQUIRED', 'REJECTED'],
  },
  {
    key: 'gpsMaxUsableAccuracyM',
    label: 'Least accurate usable GPS',
    help: 'Readings less accurate than this count as “uncertain”.',
    unit: 'm',
  },
  {
    key: 'gpsOutsideMarginM',
    label: 'Off-site margin',
    help: 'How far beyond the geofence, after allowing for accuracy, before a phone counts as off site.',
    unit: 'm',
  },
  {
    key: 'maxAttemptsPerSession',
    label: 'Attempts per class',
    help: 'After this many attempts the student asks the lecturer instead.',
  },
  {
    key: 'bleScanSeconds',
    label: 'Beacon scan',
    help: 'How long the phone listens for beacons at check-in.',
    unit: 's',
  },
  {
    key: 'qrRotationSeconds',
    label: 'QR code changes every',
    help: 'For attendance (Phase 5): 10 to 30 seconds.',
    unit: 's',
  },
  {
    key: 'qrGraceWindows',
    label: 'Previous QR codes accepted',
    help: 'How many earlier codes still work (for slow phones).',
  },
  {
    key: 'offlineGraceSeconds',
    label: 'Offline grace',
    help: 'A check-in arriving this late after a lost connection is held for the lecturer.',
    unit: 's',
  },
];

const show = (key: RuleKey, value: unknown) =>
  typeof value === 'boolean'
    ? value
      ? 'Yes'
      : 'No'
    : typeof value === 'string'
      ? (OUTCOME_LABELS[value] ?? value)
      : `${value}${RULES.find((r) => r.key === key)?.unit ?? ''}`;

export default function VerificationPolicyPage() {
  return (
    <PermissionGate permission="verification_policies.manage">
      <VerificationPolicy />
    </PermissionGate>
  );
}

function VerificationPolicy() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const history = useQuery({
    queryKey: ['verification-policies'],
    queryFn: () => auth.call<{ data: PolicyVersion[] }>('/verification-policies'),
  });
  const [editing, setEditing] = useState(false);
  if (history.isPending) return <LoadingState />;
  if (history.isError) return <Alert tone="error">{describeError(history.error)}</Alert>;
  const current = history.data.data[0]!;

  return (
    <div className="stack">
      <PageHeader
        title="Verification policy"
        subtitle="How the system decides whether a student is really in the classroom. Each change is saved as a new version with a reason; old versions are kept, so every decision can be explained later."
        actions={<Button onClick={() => setEditing(true)}>Change the policy</Button>}
      />
      <section className="card" aria-labelledby="current-policy">
        <div className="card-header">
          <h2 id="current-policy">
            Version {current.version}
            {current.version === 0 ? ' (defaults)' : ''}
          </h2>
          <span className="muted">
            {current.createdAt
              ? `${formatDateTime(current.createdAt)} · ${current.createdBy?.fullName ?? ''}`
              : ''}
          </span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {RULES.map((r) => (
                <tr key={r.key}>
                  <td>
                    <strong>{r.label}</strong>
                    <div className="secondary-text">{r.help}</div>
                  </td>
                  <td>{show(r.key, current.rules[r.key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <TryCase />
      <section className="card" aria-labelledby="policy-history">
        <div className="card-header">
          <h2 id="policy-history">Versions</h2>
        </div>
        <div className="card-body">
          <ol className="stack-sm">
            {history.data.data.map((v) => (
              <li key={v.version}>
                <strong>Version {v.version}</strong>{' '}
                <span className="muted">· {v.createdAt ? formatDateTime(v.createdAt) : 'built in'}</span>
                <div className="secondary-text">{v.reason}</div>
              </li>
            ))}
          </ol>
        </div>
      </section>
      {editing ? (
        <EditPolicy
          current={current.rules}
          onClose={() => setEditing(false)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['verification-policies'] })}
        />
      ) : null}
    </div>
  );
}

function EditPolicy(props: {
  current: VerificationRules;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(RULES.map((r) => [r.key, String(props.current[r.key])])),
  );
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      title="Change the verification policy"
      description="Saving creates a new version. Attendance sessions already running keep the version they started with."
      submitLabel="Save new version"
      validate={() => {
        if (reason.trim().length < 5) return 'Explain the change, at least 5 characters.';
        const bad = RULES.find((r) => !r.options && !/^\d+$/.test(values[r.key] ?? ''));
        return bad ? `${bad.label}: enter a whole number.` : null;
      }}
      onSubmit={async () => {
        const rules = Object.fromEntries(
          RULES.map((r) => {
            const v = values[r.key]!;
            return [r.key, r.options ? (v === 'true' ? true : v === 'false' ? false : v) : Number(v)];
          }),
        );
        await auth.call('/verification-policies', { method: 'POST', body: { rules, reason: reason.trim() } });
        await props.onDone();
      }}
      onClose={props.onClose}
    >
      {RULES.map((r) =>
        r.options ? (
          <SelectField
            key={r.key}
            label={r.label}
            name={r.key}
            value={values[r.key]!}
            onChange={(v) => setValues((s) => ({ ...s, [r.key]: v }))}
            options={r.options.map((o) => ({
              value: o,
              label: o === 'true' ? 'Yes' : o === 'false' ? 'No' : (OUTCOME_LABELS[o] ?? o),
            }))}
          />
        ) : (
          <Field
            key={r.key}
            label={`${r.label}${r.unit ? ` (${r.unit})` : ''}`}
            name={r.key}
            inputMode="numeric"
            value={values[r.key]!}
            onChange={(v) => setValues((s) => ({ ...s, [r.key]: v }))}
          />
        ),
      )}
      <Field
        label="Reason (recorded)"
        name="reason"
        multiline
        value={reason}
        onChange={setReason}
        maxLength={500}
      />
    </FormDialog>
  );
}

interface TryResult {
  policyVersion: number;
  outcome: string;
  message: string;
  flags: string[];
  trace: string[];
}

/** "What would happen if…": evidence chosen by hand, decided by the current policy. Nothing is saved. */
function TryCase() {
  const auth = useAuth();
  const [ble, setBle] = useState('STRONG');
  const [gps, setGps] = useState('INSIDE');
  const [device, setDevice] = useState('TRUSTED');
  const [integrity, setIntegrity] = useState('NOT_AVAILABLE');
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    try {
      setResult(
        await auth.call<TryResult>('/verification-policies/try', {
          method: 'POST',
          body: { ble, gps, device, integrity },
        }),
      );
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <section className="card" aria-labelledby="try-case">
      <div className="card-header">
        <h2 id="try-case">Try a case</h2>
      </div>
      <div className="card-body stack-sm">
        <p className="secondary-text">
          Choose the evidence a check-in would bring, and see what the current policy decides.
        </p>
        <div className="row">
          <SelectField
            label="Beacon"
            name="ble"
            value={ble}
            onChange={setBle}
            options={BLE_RESULTS.map((v) => ({ value: v, label: v }))}
          />
          <SelectField
            label="GPS"
            name="gps"
            value={gps}
            onChange={setGps}
            options={GPS_RESULTS.map((v) => ({ value: v, label: v }))}
          />
          <SelectField
            label="Phone"
            name="device"
            value={device}
            onChange={setDevice}
            options={[
              { value: 'TRUSTED', label: 'Approved attendance phone' },
              { value: 'PENDING_APPROVAL', label: 'New phone, waiting for approval' },
            ]}
          />
          <SelectField
            label="Integrity"
            name="integrity"
            value={integrity}
            onChange={setIntegrity}
            options={INTEGRITY_RESULTS.map((v) => ({ value: v, label: v }))}
          />
          <Button variant="secondary" onClick={() => void run()} style={{ alignSelf: 'flex-end' }}>
            Decide
          </Button>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result ? (
          <div className="stack-sm">
            <div className="row">
              <StatusBadge
                tone={
                  result.outcome === 'VERIFIED'
                    ? 'success'
                    : result.outcome === 'REJECTED'
                      ? 'error'
                      : 'warning'
                }
                label={OUTCOME_LABELS[result.outcome] ?? result.outcome}
              />
              <span>Student sees: “{result.message}”</span>
              {result.flags.length ? <span className="muted">Flags: {result.flags.join(', ')}</span> : null}
            </div>
            <ol className="secondary-text">
              {result.trace.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}
