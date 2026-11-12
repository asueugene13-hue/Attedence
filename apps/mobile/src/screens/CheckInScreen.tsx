import { useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { BodyText, Button, Card, Heading, Notice, Screen } from '../components/ui';
import { describeError } from '../lib/api';
import {
  type CheckInResult,
  isAttendanceCode,
  newIdempotencyKey,
  type OpenAttendance,
  OUTCOME_DISPLAY,
  RECORD_LABELS,
  submitCheckIn,
} from '../lib/attendance';
import { useAuth } from '../lib/auth';
import { useDevice } from '../lib/device-context';
import { readLocation, SCAN_SECONDS, scanBeacons } from '../lib/presence';
import { useScanList } from '../lib/rooms';
import { useTheme } from '../lib/theme';

type Step = 'scan' | 'classroom' | 'location' | 'sending' | 'waiting' | 'done';
const STEPS: { key: Exclude<Step, 'scan' | 'done' | 'waiting'>; label: string }[] = [
  { key: 'classroom', label: `Listening for the classroom (${SCAN_SECONDS} s)` },
  { key: 'location', label: 'Checking your location' },
  { key: 'sending', label: 'Sending to AttendSure' },
];

/**
 * Checking in (ATTENDANCE_FLOW §3): scan the code shown in class; the phone then listens for the
 * classroom's beacon, reads its location once, and sends everything, signed by this phone. "Checked
 * in" appears only when the server says so.
 */
export function CheckInScreen() {
  const { call } = useAuth();
  const { device, error: deviceError, callSigned } = useDevice();
  const { palette } = useTheme();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const scanList = useScanList();
  const [permission, requestPermission] = useCameraPermissions();
  const open = useQuery({
    queryKey: ['open-attendance'],
    queryFn: () => call<{ data: OpenAttendance[] }>('/me/open-attendance'),
    refetchInterval: 30_000,
  });
  const [step, setStep] = useState<Step>('scan');
  const [heard, setHeard] = useState(0);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const handling = useRef(false);

  async function onCode(text: string) {
    if (handling.current) return;
    if (!isAttendanceCode(text)) {
      setProblem('That is not an AttendSure attendance code. Scan the code shown in class.');
      return;
    }
    handling.current = true;
    setProblem(null);
    setResult(null);
    setHeard(0);
    try {
      setStep('classroom');
      const scan = await scanBeacons(
        new Set((scanList.data?.data ?? []).map((b) => b.identifier)),
        SCAN_SECONDS,
        setHeard,
      );
      setStep('location');
      const location = await readLocation();
      setStep('sending');
      const key = newIdempotencyKey((n) => Crypto.getRandomValues(new Uint8Array(n)));
      const answer = await submitCheckIn(
        (k) =>
          callSigned<CheckInResult>('/check-ins', {
            method: 'POST',
            headers: { 'Idempotency-Key': k },
            body: { qrToken: text.trim(), bluetooth: scan.bluetooth, readings: scan.readings, location },
          }),
        key,
        (waiting) => setStep(waiting ? 'waiting' : 'sending'),
      );
      setResult(answer);
      setStep('done');
      await queryClient.invalidateQueries({ queryKey: ['open-attendance'] });
      await queryClient.invalidateQueries({ queryKey: ['my-attendance'] });
    } catch (e) {
      setProblem(describeError(e));
      setStep('scan');
    } finally {
      handling.current = false;
    }
  }

  const again = () => {
    setResult(null);
    setProblem(null);
    setStep('scan');
  };

  if (deviceError || !device) {
    return (
      <Screen>
        <Heading>Check in</Heading>
        {deviceError ? (
          <Notice tone="error">{`This phone is not registered: ${deviceError}`}</Notice>
        ) : (
          <BodyText muted>Registering this phone…</BodyText>
        )}
      </Screen>
    );
  }

  if (step === 'done' && result) {
    const display = OUTCOME_DISPLAY[result.outcome];
    return (
      <Screen>
        <Heading>{display.title}</Heading>
        <Notice tone={display.tone}>{result.message}</Notice>
        {result.recordStatus ? (
          <BodyText>{`Your attendance for this class: ${RECORD_LABELS[result.recordStatus] ?? result.recordStatus}.`}</BodyText>
        ) : null}
        <BodyText
          muted
        >{`Received by AttendSure at ${new Date(result.receivedAt).toLocaleTimeString()}.`}</BodyText>
        {result.retryAllowed ? (
          <Button label="Try again" onPress={again} />
        ) : (
          <Button label="Done" variant="secondary" onPress={again} />
        )}
      </Screen>
    );
  }

  if (step !== 'scan') {
    const index = STEPS.findIndex((s) => s.key === step);
    return (
      <Screen>
        <Heading>Checking you in…</Heading>
        <Card>
          <Text style={{ color: palette.textPrimary }}>✓ Code read</Text>
          {STEPS.map((s, i) => (
            <Text
              key={s.key}
              style={{ color: i <= index || step === 'waiting' ? palette.textPrimary : palette.textMuted }}
            >
              {`${i < index || step === 'waiting' ? '✓' : i === index ? '…' : '·'} ${s.label}${s.key === 'classroom' && step === 'classroom' ? ` · ${heard} reading${heard === 1 ? '' : 's'}` : ''}`}
            </Text>
          ))}
        </Card>
        {step === 'waiting' ? (
          <Notice tone="info">
            Waiting for a connection… Your check-in is kept and sent as soon as the phone is back online (for
            up to 2 minutes).
          </Notice>
        ) : null}
      </Screen>
    );
  }

  const sessions = open.data?.data ?? [];
  return (
    <Screen scroll={false}>
      <Heading subtitle="Scan the code your lecturer shows.">Check in</Heading>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {open.isPending ? <BodyText muted>Checking for open attendance…</BodyText> : null}
      {open.isError ? <Notice tone="error">{describeError(open.error)}</Notice> : null}
      {open.data && sessions.length === 0 ? (
        <Card>
          <BodyText>
            No attendance is open for your classes right now. When your lecturer opens it, you can scan here.
          </BodyText>
          <Button label="Check again" variant="secondary" onPress={() => void open.refetch()} />
        </Card>
      ) : null}
      {sessions.length > 0 ? (
        <>
          {sessions.map((s) => (
            <BodyText key={s.attendanceSessionId}>
              {`${s.course ? `${s.course.code} ` : ''}open until ${new Date(s.closesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${s.myStatus ? ` · you: ${RECORD_LABELS[s.myStatus] ?? s.myStatus}` : ''}`}
            </BodyText>
          ))}
          {!permission ? null : !permission.granted ? (
            <Card>
              <BodyText>
                AttendSure needs the camera only to read the attendance code. Nothing is recorded or kept.
              </BodyText>
              <Button label="Allow the camera" onPress={() => void requestPermission()} />
            </Card>
          ) : focused ? (
            <View style={{ flex: 1, minHeight: 320, borderRadius: 12, overflow: 'hidden' }}>
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => void onCode(data)}
                accessibilityLabel="Camera: point it at the attendance code"
              />
            </View>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
