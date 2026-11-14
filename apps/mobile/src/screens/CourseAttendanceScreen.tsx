import { type RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Text, View } from 'react-native';
import { Pill } from '../components/phase6';
import { BodyText, Button, Card, Heading, Notice, Screen } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { classWhen, RECORD_STATUS_LABELS, type Tone } from '../lib/requests';
import { useTheme } from '../lib/theme';
import type { RootNavigation, RootStackParamList } from '../navigation/types';

interface CourseDetail {
  course: { code: string; title: string };
  percentage: number | null;
  classes: {
    classSessionId: string;
    scheduledStart: string;
    counted: boolean;
    notCounted: string | null;
    outcome: string | null;
    record: string | null;
  }[];
}

const NOT_COUNTED: Record<string, string> = {
  CANCELLED: 'Cancelled (not counted)',
  VOIDED: 'Voided (not counted)',
  NOT_ENROLLED_YET: 'Before you enrolled',
  NOT_HELD_YET: 'Not held yet',
  UNDER_REVIEW: 'Class under review',
  NO_ATTENDANCE_TAKEN: 'No attendance taken',
  ATTENDANCE_OPEN: 'Attendance open now',
  NO_RECORD: 'No record',
};
const TONE: Record<string, Tone> = {
  PRESENT: 'success',
  LATE: 'warning',
  ABSENT: 'error',
  REJECTED: 'error',
  PENDING: 'warning',
  UNDER_REVIEW: 'warning',
  EXCUSED: 'info',
  VOIDED: 'neutral',
};

/** One course, class by class, with a way to dispute an absent or rejected record. */
export function CourseAttendanceScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'CourseAttendance'>>();
  const navigation = useNavigation<RootNavigation>();
  const { call } = useAuth();
  const { palette } = useTheme();
  const detail = useQuery({
    queryKey: ['my-attendance', route.params.offeringId],
    queryFn: () => call<CourseDetail>(`/me/attendance/offerings/${route.params.offeringId}`),
  });
  const d = detail.data;
  return (
    <Screen>
      {detail.isPending ? <BodyText muted>Loading…</BodyText> : null}
      {detail.isError ? <Notice tone="error">{describeError(detail.error)}</Notice> : null}
      {d ? (
        <>
          <Heading
            subtitle={d.percentage === null ? 'Nothing has counted yet.' : `${d.percentage}% attendance`}
          >
            {`${d.course.code} · ${d.course.title}`}
          </Heading>
          {d.classes.length === 0 ? <BodyText muted>No classes yet.</BodyText> : null}
          {[...d.classes].reverse().map((c) => {
            const status = c.record;
            const disputable = status === 'ABSENT' || status === 'REJECTED';
            return (
              <Card key={c.classSessionId}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>
                    {classWhen(c.scheduledStart)}
                  </Text>
                  {status ? (
                    <Pill label={RECORD_STATUS_LABELS[status] ?? status} tone={TONE[status] ?? 'neutral'} />
                  ) : null}
                </View>
                {c.notCounted ? <BodyText muted>{NOT_COUNTED[c.notCounted] ?? c.notCounted}</BodyText> : null}
                {disputable ? (
                  <Button
                    label="Dispute this record"
                    variant="secondary"
                    onPress={() =>
                      navigation.navigate('DisputeForm', {
                        classSessionId: c.classSessionId,
                        title: `${d.course.code} · ${classWhen(c.scheduledStart)}`,
                        status,
                      })
                    }
                  />
                ) : null}
              </Card>
            );
          })}
        </>
      ) : null}
    </Screen>
  );
}
