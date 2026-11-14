import { useIsFocused } from '@react-navigation/native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Pill } from '../components/phase6';
import { BodyText, Button, Card, Notice, Screen } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

export interface CheckResult {
  result: 'GENUINE' | 'EXPIRED' | 'NOT_GENUINE';
  checkedAt: string;
  photo: { url: string } | null;
  student: {
    fullName: string;
    studentNumber: string;
    programme: { name: string };
    level: { name: string } | null;
    status: string;
    active: boolean;
  } | null;
}

/** Staff scan a student's ID code; the server says whether it is genuine and whose it is (logged). */
export function CheckIdScreen() {
  const { call } = useAuth();
  const focused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function onCode(code: string) {
    if (busy.current || result) return;
    busy.current = true;
    setError(null);
    try {
      setResult(await call<CheckResult>('/student-ids/check', { method: 'POST', body: { code } }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      busy.current = false;
    }
  }

  if (result) return <CheckIdResult result={result} onAgain={() => setResult(null)} />;

  return (
    <Screen scroll={false}>
      <BodyText>Point the camera at the code on the student’s ID card.</BodyText>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!permission ? null : !permission.granted ? (
        <Card>
          <BodyText>AttendSure needs the camera only to read the code. Nothing is recorded or kept.</BodyText>
          <Button label="Allow the camera" onPress={() => void requestPermission()} />
        </Card>
      ) : focused ? (
        <View style={{ flex: 1, minHeight: 320, borderRadius: 12, overflow: 'hidden' }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => void onCode(data)}
            accessibilityLabel="Camera: point it at the student’s ID code"
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** What the check found (as on the design canvas: Staff · ID check result). */
export function CheckIdResult({ result, onAgain }: { result: CheckResult; onAgain: () => void }) {
  const { palette, spacing, radius } = useTheme();
  const s = result.student;
  return (
    <Screen>
      {result.result === 'GENUINE' && s ? (
        <>
          <Notice tone={s.active ? 'success' : 'error'}>
            {s.active
              ? 'Genuine ID · active student'
              : `Genuine ID · not an active student (${s.status.toLowerCase()})`}
          </Notice>
          <Card>
            <View style={{ flexDirection: 'row', gap: spacing[4], alignItems: 'center' }}>
              {result.photo ? (
                <Image
                  source={{ uri: result.photo.url }}
                  style={{ width: 112, height: 140, borderRadius: radius.card }}
                  accessibilityLabel="Photo from the Registrar’s record"
                />
              ) : (
                <View
                  style={{
                    width: 112,
                    height: 140,
                    borderRadius: radius.card,
                    backgroundColor: palette.primaryTint,
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 8,
                  }}
                >
                  <Text style={{ color: palette.primary, fontSize: 12, textAlign: 'center' }}>
                    No photo on record
                  </Text>
                </View>
              )}
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={{ color: palette.textPrimary, fontSize: 18, fontWeight: '600' }}>
                  {s.fullName}
                </Text>
                <Text style={{ color: palette.textSecondary, fontSize: 15, fontWeight: '600' }}>
                  {s.studentNumber}
                </Text>
                <BodyText muted>{`${s.programme.name}${s.level ? ` · ${s.level.name}` : ''}`}</BodyText>
                <Pill
                  label={s.active ? 'Active' : s.status.toLowerCase()}
                  tone={s.active ? 'success' : 'error'}
                />
              </View>
            </View>
          </Card>
          <BodyText muted>
            Compare the photo with the person in front of you. It comes from the Registrar’s record, not the
            student’s phone.
          </BodyText>
        </>
      ) : (
        <Notice tone="error">
          {result.result === 'EXPIRED'
            ? 'This code has expired. Ask the student to open their ID card again while online.'
            : 'This is not a genuine AttendSure student ID code.'}
        </Notice>
      )}
      <BodyText muted>This check is recorded with your name and the time.</BodyText>
      <Button label="Scan another ID" onPress={onAgain} />
    </Screen>
  );
}
