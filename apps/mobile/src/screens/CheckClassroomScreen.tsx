import { useState } from 'react';
import { Text, View } from 'react-native';
import { ChoiceChips } from '../components/choice-chips';
import { BodyText, Button, Card, Heading, Notice, Screen } from '../components/ui';
import { describeError } from '../lib/api';
import { useDevice } from '../lib/device-context';
import { readLocation, SCAN_SECONDS, scanBeacons } from '../lib/presence';
import { useScanList } from '../lib/rooms';
import { useTheme } from '../lib/theme';

type Outcome = 'VERIFIED' | 'PENDING_VERIFICATION' | 'MANUAL_REVIEW_REQUIRED' | 'REJECTED';
interface CheckResult {
  policyVersion: number;
  classroom: { id: string; code: string; name: string };
  evidence: {
    ble: 'STRONG' | 'WEAK' | 'OTHER_ROOM' | 'NONE' | 'OFF';
    strongestOwnRssi: number | null;
    recognisedReadings: number;
    gps: 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN' | 'MOCKED';
    distanceM: number | null;
    hasGeofence: boolean;
    device: string;
  };
  decision: { outcome: Outcome; message: string; retryAllowed: boolean };
}

const BLE_LABELS: Record<CheckResult['evidence']['ble'], string> = {
  STRONG: 'Strong signal from this room’s beacon',
  WEAK: 'Weak signal from this room’s beacon',
  OTHER_ROOM: 'Another room’s beacon is the strongest',
  NONE: 'No classroom beacon heard',
  OFF: 'Bluetooth is off or not allowed',
};
const GPS_LABELS: Record<CheckResult['evidence']['gps'], string> = {
  INSIDE: 'On the site',
  OUTSIDE: 'Away from the site',
  UNCERTAIN: 'Not sure (no reading, or too imprecise)',
  MOCKED: 'The location looks faked',
};
const OUTCOME_LABELS: Record<Outcome, string> = {
  VERIFIED: 'Would be verified',
  PENDING_VERIFICATION: 'Would wait for the lecturer to confirm',
  MANUAL_REVIEW_REQUIRED: 'Would go to review',
  REJECTED: 'Would not be accepted',
};
const DEVICE_LABELS: Record<string, string> = {
  TRUSTED: 'Approved phone',
  PENDING_APPROVAL: 'Waiting for approval',
};

type Step = 'idle' | 'scanning' | 'locating' | 'deciding';

/**
 * "Check this classroom": runs this phone's real evidence through the real rules for a room, so a
 * room (or the phone) can be tried before attendance starts. Nothing is recorded.
 */
export function CheckClassroomScreen() {
  const { palette } = useTheme();
  const { device, error: deviceError, callSigned } = useDevice();
  const scanList = useScanList();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [heard, setHeard] = useState(0);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function run() {
    if (!roomId || !scanList.data) return;
    setProblem(null);
    setResult(null);
    setHeard(0);
    try {
      setStep('scanning');
      const scan = await scanBeacons(
        new Set(scanList.data.data.map((b) => b.identifier)),
        SCAN_SECONDS,
        setHeard,
      );
      setStep('locating');
      const location = await readLocation();
      setStep('deciding');
      setResult(
        await callSigned<CheckResult>('/classroom-checks', {
          method: 'POST',
          body: { classroomId: roomId, bluetooth: scan.bluetooth, readings: scan.readings, location },
        }),
      );
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setStep('idle');
    }
  }

  const row = (label: string, value: string) => (
    <View style={{ gap: 2 }}>
      <Text style={{ color: palette.textMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: palette.textPrimary, fontSize: 15 }}>{value}</Text>
    </View>
  );
  const busy = step !== 'idle';
  const rooms = scanList.data?.rooms ?? [];

  return (
    <Screen>
      <Heading subtitle="Try a room before class. Nothing is recorded.">Check this classroom</Heading>
      <Card>
        <BodyText>
          {`AttendSure listens for the classroom’s Bluetooth beacons for ${SCAN_SECONDS} seconds and reads your location once. It never tracks you in the background. Your phone may ask for permission to find nearby devices and to use your location.`}
        </BodyText>
      </Card>

      {deviceError ? (
        <Notice tone="error">{`This phone is not registered: ${deviceError}`}</Notice>
      ) : !device ? (
        <BodyText muted>Registering this phone…</BodyText>
      ) : null}

      <Card>
        <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Room</Text>
        {scanList.isPending ? (
          <BodyText muted>Loading rooms…</BodyText>
        ) : scanList.isError ? (
          <>
            <Notice tone="error">{describeError(scanList.error)}</Notice>
            <Button label="Try again" variant="secondary" onPress={() => void scanList.refetch()} />
          </>
        ) : rooms.length === 0 ? (
          <BodyText muted>
            No room has a beacon registered yet. Beacons are added on the web dashboard.
          </BodyText>
        ) : (
          <ChoiceChips
            choices={rooms.map((r) => [r.id, `${r.code} · ${r.name}`] as const)}
            value={roomId}
            onChange={setRoomId}
            disabled={busy}
          />
        )}
        <Button label="Check now" busy={busy} disabled={!roomId || !device} onPress={() => void run()} />
        {step === 'scanning' ? (
          <BodyText
            muted
          >{`Listening for beacons… ${heard} reading${heard === 1 ? '' : 's'} so far`}</BodyText>
        ) : step === 'locating' ? (
          <BodyText muted>Reading your location…</BodyText>
        ) : step === 'deciding' ? (
          <BodyText muted>Asking AttendSure…</BodyText>
        ) : null}
      </Card>

      {problem ? <Notice tone="error">{problem}</Notice> : null}

      {result ? (
        <Card>
          <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>
            {`${result.classroom.code} · ${OUTCOME_LABELS[result.decision.outcome]}`}
          </Text>
          <Notice
            tone={
              result.decision.outcome === 'VERIFIED'
                ? 'success'
                : result.decision.outcome === 'REJECTED'
                  ? 'error'
                  : 'info'
            }
          >
            {/* "You're checked in" would be untrue here: this check records nothing. */}
            {result.decision.outcome === 'VERIFIED'
              ? 'A check-in from here would be verified. (Nothing was recorded.)'
              : result.decision.message}
          </Notice>
          {row(
            'Bluetooth',
            `${BLE_LABELS[result.evidence.ble]}${result.evidence.strongestOwnRssi === null ? '' : ` (${result.evidence.strongestOwnRssi} dBm)`}`,
          )}
          {row('Beacon readings recognised', String(result.evidence.recognisedReadings))}
          {row(
            'Location',
            result.evidence.hasGeofence
              ? `${GPS_LABELS[result.evidence.gps]}${result.evidence.distanceM === null ? '' : `, ${result.evidence.distanceM} m from the centre`}`
              : 'No site boundary is set for this room, so location is not used',
          )}
          {row('This phone', DEVICE_LABELS[result.evidence.device] ?? result.evidence.device)}
          <BodyText
            muted
          >{`Rules version ${result.policyVersion}. A real check-in also needs the class QR code.`}</BodyText>
        </Card>
      ) : null}
    </Screen>
  );
}
