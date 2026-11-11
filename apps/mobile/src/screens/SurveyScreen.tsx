import { SURVEY_POSITIONS, type SurveyPosition } from '@attendsure/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Device from 'expo-device';
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { ChoiceChips } from '../components/choice-chips';
import { BodyText, Button, Card, Heading, Notice, Screen } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { medianRssi } from '../lib/beacon-frames';
import { SCAN_SECONDS, scanBeacons } from '../lib/presence';
import { beaconShortName, useScanList } from '../lib/rooms';
import { useTheme } from '../lib/theme';

const POSITION_LABELS: Record<SurveyPosition, string> = {
  INSIDE_FRONT: 'Inside: front',
  INSIDE_MIDDLE: 'Inside: middle',
  INSIDE_BACK_ROW: 'Inside: back row',
  INSIDE_CORNER: 'Inside: a corner',
  DOORWAY: 'Doorway',
  CORRIDOR: 'Corridor',
  NEIGHBOUR_ROOM: 'Next room',
  OUTSIDE_BUILDING: 'Outside the building',
};
const PROBLEM_LABELS: Record<string, string> = {
  NOT_ENOUGH_PHONES: 'Needs readings from at least three phone models.',
  NO_INSIDE_READINGS: 'Not heard inside the room.',
  NO_OUTSIDE_READINGS: 'No readings from outside the room yet.',
  OVERLAP: 'As strong outside as inside: move the beacon or measure again.',
};

interface Calibration {
  beaconId: string;
  phoneModels: number;
  thresholdRssi: number | null;
  problem: string | null;
}
interface Survey {
  id: string;
  surveyedAt: string;
  appliedAt: string | null;
  result: Calibration[];
}
interface Measurement {
  beaconId: string;
  position: SurveyPosition;
  rssi: number;
}

/** This phone's model, as the calibration counts phone models (they hear beacons differently). */
const phoneModel = () =>
  [Device.manufacturer, Device.modelName].filter(Boolean).join(' ').trim() || 'Unknown phone';

/**
 * Staff survey mode (PRESENCE_VERIFICATION.md §3): measure a room's beacons from positions inside and
 * outside. Each phone adds its own readings to the same survey; a threshold is set only when someone
 * applies the survey on the web dashboard.
 */
export function SurveyScreen() {
  const { palette } = useTheme();
  const { call } = useAuth();
  const queryClient = useQueryClient();
  const scanList = useScanList();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [surveyId, setSurveyId] = useState<string>('new');
  const [position, setPosition] = useState<SurveyPosition | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [busy, setBusy] = useState<'scan' | 'save' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notHeard, setNotHeard] = useState<string[]>([]);
  const [saved, setSaved] = useState<Survey | null>(null);

  const surveys = useQuery({
    queryKey: ['calibration-surveys', roomId],
    queryFn: () => call<{ data: Survey[] }>(`/calibration-surveys?classroomId=${roomId}`),
    enabled: Boolean(roomId),
  });
  const openSurveys = (surveys.data?.data ?? []).filter((s) => !s.appliedAt);
  const roomBeacons = (scanList.data?.data ?? []).filter((b) => b.classroomId === roomId);
  const beaconName = (id: string) => {
    const b = roomBeacons.find((x) => x.id === id);
    return b ? beaconShortName(b) : 'Beacon';
  };

  function chooseRoom(id: string) {
    setRoomId(id);
    setSurveyId('new');
    setMeasurements([]);
    setSaved(null);
    setProblem(null);
    setNotHeard([]);
  }

  async function measure() {
    if (!position) return;
    setBusy('scan');
    setProblem(null);
    setNotHeard([]);
    try {
      const scan = await scanBeacons(new Set(roomBeacons.map((b) => b.identifier)));
      if (scan.bluetooth !== 'ON') {
        setProblem(
          scan.bluetooth === 'DENIED'
            ? 'AttendSure is not allowed to use Bluetooth. Allow “Nearby devices” in the phone’s settings.'
            : 'Bluetooth is off. Turn it on and measure again.',
        );
        return;
      }
      const taken: Measurement[] = [];
      const missing: string[] = [];
      for (const b of roomBeacons) {
        const rssi = medianRssi(scan.readings, b.identifier);
        if (rssi === null) missing.push(beaconShortName(b));
        else taken.push({ beaconId: b.id, position, rssi });
      }
      // A beacon not heard from outside the room is good news; it simply adds no reading.
      setNotHeard(missing);
      setMeasurements((m) => [...m.filter((x) => x.position !== position), ...taken]);
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!roomId || measurements.length === 0) return;
    setBusy('save');
    setProblem(null);
    const rows = measurements.map((m) => ({
      ...m,
      phoneModel: phoneModel(),
      platform: Platform.OS === 'ios' ? ('IOS' as const) : ('ANDROID' as const),
    }));
    try {
      const survey =
        surveyId === 'new'
          ? await call<Survey>('/calibration-surveys', {
              method: 'POST',
              body: { classroomId: roomId, measurements: rows },
            })
          : await call<Survey>(`/calibration-surveys/${surveyId}/measurements`, {
              method: 'POST',
              body: { measurements: rows },
            });
      setSaved(survey);
      setSurveyId(survey.id);
      setMeasurements([]);
      await queryClient.invalidateQueries({ queryKey: ['calibration-surveys', roomId] });
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  const rooms = scanList.data?.rooms ?? [];
  const positionsDone = new Set(measurements.map((m) => m.position));

  return (
    <Screen>
      <Heading subtitle={`Measuring with: ${phoneModel()}`}>Beacon survey</Heading>
      <Card>
        <BodyText>
          Stand at each position and tap “Measure here”. Measure inside the room (front, middle, back row, a
          corner) and outside it (doorway, corridor, next room). Then repeat with at least three different
          phone models; each phone adds its readings to the same survey. Thresholds change only when the
          survey is applied on the web dashboard.
        </BodyText>
      </Card>

      <Card>
        <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Room</Text>
        {scanList.isPending ? (
          <BodyText muted>Loading rooms…</BodyText>
        ) : scanList.isError ? (
          <Notice tone="error">{describeError(scanList.error)}</Notice>
        ) : rooms.length === 0 ? (
          <BodyText muted>
            No room has a beacon registered yet. Register beacons on the web dashboard.
          </BodyText>
        ) : (
          <ChoiceChips
            choices={rooms.map((r) => [r.id, `${r.code} · ${r.name}`] as const)}
            value={roomId}
            onChange={chooseRoom}
            disabled={busy !== null}
          />
        )}
      </Card>

      {roomId ? (
        <Card>
          <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Survey</Text>
          {surveys.isError ? <Notice tone="error">{describeError(surveys.error)}</Notice> : null}
          <ChoiceChips
            choices={[
              ['new', 'Start a new survey'] as const,
              ...openSurveys.map(
                (s) =>
                  [
                    s.id,
                    `Add to survey of ${new Date(s.surveyedAt).toLocaleDateString()} (${Math.max(0, ...s.result.map((r) => r.phoneModels))} phone models)`,
                  ] as const,
              ),
            ]}
            value={surveyId}
            onChange={setSurveyId}
            disabled={busy !== null}
          />
          <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Where are you standing?</Text>
          <ChoiceChips
            choices={SURVEY_POSITIONS.map(
              (p) => [p, `${positionsDone.has(p) ? '✓ ' : ''}${POSITION_LABELS[p]}`] as const,
            )}
            value={position}
            onChange={setPosition}
            disabled={busy !== null}
          />
          <Button
            label={`Measure here (${SCAN_SECONDS} s)`}
            busy={busy === 'scan'}
            disabled={!position || busy !== null}
            onPress={() => void measure()}
          />
          {notHeard.length > 0 ? (
            <Notice tone="info">{`Not heard here: ${notHeard.join(', ')}.`}</Notice>
          ) : null}
          {measurements.length > 0 ? (
            <View style={{ gap: 4 }}>
              {measurements.map((m) => (
                <BodyText key={`${m.position}-${m.beaconId}`}>
                  {`${POSITION_LABELS[m.position]} · ${beaconName(m.beaconId)}: ${m.rssi} dBm`}
                </BodyText>
              ))}
            </View>
          ) : null}
          <Button
            label="Save these readings"
            busy={busy === 'save'}
            disabled={measurements.length === 0 || busy !== null}
            onPress={() => void save()}
          />
        </Card>
      ) : null}

      {problem ? <Notice tone="error">{problem}</Notice> : null}

      {saved ? (
        <Card>
          <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Saved. The survey so far:</Text>
          {saved.result.map((r) => (
            <BodyText key={r.beaconId}>
              {`${beaconName(r.beaconId)}: ${r.problem ? (PROBLEM_LABELS[r.problem] ?? r.problem) : `threshold ${r.thresholdRssi} dBm`} (${r.phoneModels} phone model${r.phoneModels === 1 ? '' : 's'})`}
            </BodyText>
          ))}
          <BodyText muted>
            Apply the survey on the web dashboard (Beacons) once every beacon has a threshold.
          </BodyText>
        </Card>
      ) : null}
    </Screen>
  );
}
