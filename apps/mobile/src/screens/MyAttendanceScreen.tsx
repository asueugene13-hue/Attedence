import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BodyText, Button, Card, Heading, Notice } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';

interface CourseAttendance {
  offeringId: string;
  course: { code: string; title: string };
  semester: { name: string };
  enrolled: boolean;
  eligible: number;
  present: number;
  late: number;
  absences: number;
  excused: number;
  undecided: number;
  cancelled: number;
  percentage: number | null;
  warning: {
    minimumPercent: number;
    belowMinimum: boolean;
    absencesAllowed: number;
    remainingClasses: number;
  } | null;
}

/** The student's attendance per course (ATTENDANCE_FLOW §9), from the server's own calculation. */
export function MyAttendanceScreen() {
  const { call } = useAuth();
  const navigation = useNavigation<RootNavigation>();
  const { palette, spacing } = useTheme();
  const attendance = useQuery({
    queryKey: ['my-attendance'],
    queryFn: () => call<{ data: CourseAttendance[]; minimumPercent: number | null }>('/me/attendance'),
  });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[5], gap: spacing[4] }}
        refreshControl={
          <RefreshControl refreshing={attendance.isFetching} onRefresh={() => void attendance.refetch()} />
        }
      >
        <Heading subtitle="Cancelled classes never count against you. Open a course to see each class or dispute a record.">
          My attendance
        </Heading>
        <View style={{ flexDirection: 'row', gap: spacing[3] }}>
          <View style={{ flex: 1 }}>
            <Button
              label="My requests"
              variant="secondary"
              onPress={() => navigation.navigate('MyRequests')}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="Request an excuse"
              variant="secondary"
              onPress={() => navigation.navigate('ExcuseForm')}
            />
          </View>
        </View>
        {attendance.isPending ? <BodyText muted>Loading…</BodyText> : null}
        {attendance.isError ? <Notice tone="error">{describeError(attendance.error)}</Notice> : null}
        {attendance.data?.data.length === 0 ? (
          <BodyText muted>You are not enrolled in any course yet.</BodyText>
        ) : null}
        {attendance.data?.data.map((c) => (
          <Pressable
            key={c.offeringId}
            accessibilityRole="button"
            accessibilityLabel={`${c.course.code} ${c.course.title}: open each class`}
            onPress={() => navigation.navigate('CourseAttendance', { offeringId: c.offeringId })}
          >
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text
                  style={{ color: palette.textPrimary, fontWeight: '600', flexShrink: 1 }}
                >{`${c.course.code} · ${c.course.title}`}</Text>
                <Text style={{ color: palette.textPrimary, fontWeight: '700', fontSize: 18 }}>
                  {c.percentage === null ? '—' : `${c.percentage}%`}
                </Text>
              </View>
              <BodyText muted>
                {c.eligible === 0
                  ? 'No class has counted yet.'
                  : `${c.present} present · ${c.late} late · ${c.absences} absent${c.excused ? ` · ${c.excused} excused` : ''} · of ${c.eligible} classes`}
              </BodyText>
              {c.undecided ? (
                <BodyText
                  muted
                >{`${c.undecided} check-in${c.undecided === 1 ? '' : 's'} waiting for a decision`}</BodyText>
              ) : null}
              {c.cancelled ? <BodyText muted>{`${c.cancelled} cancelled (not counted)`}</BodyText> : null}
              {c.warning?.belowMinimum ? (
                <Notice tone="error">{`Below the ${c.warning.minimumPercent}% minimum.`}</Notice>
              ) : c.warning ? (
                <BodyText
                  muted
                >{`You can miss ${c.warning.absencesAllowed} more of ${c.warning.remainingClasses} remaining classes and stay at ${c.warning.minimumPercent}%.`}</BodyText>
              ) : null}
            </Card>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
