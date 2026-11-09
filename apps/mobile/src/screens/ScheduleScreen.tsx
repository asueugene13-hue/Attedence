import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ClassCard } from '../components/class-card';
import { BodyText, Heading, Notice } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDays, type ClassSession, dayOf, localDay } from '../lib/classes';
import { textStyle, useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';

const DAYS_AHEAD = 14;

/** The next two weeks of classes, grouped by day. Cancelled and moved classes stay visible. */
export function ScheduleScreen() {
  const { call } = useAuth();
  const navigation = useNavigation<RootNavigation>();
  const { palette, spacing, typography } = useTheme();
  const from = localDay();
  const to = addDays(from, DAYS_AHEAD);
  const classes = useQuery({
    queryKey: ['my-timetable', from, to],
    queryFn: () => call<{ data: ClassSession[] }>(`/me/timetable?from=${from}&to=${to}`),
  });
  const byDay = new Map<string, ClassSession[]>();
  for (const s of classes.data?.data ?? []) {
    const day = localDay(new Date(s.scheduledStart));
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[5], gap: spacing[5] }}
        refreshControl={
          <RefreshControl refreshing={classes.isFetching} onRefresh={() => void classes.refetch()} />
        }
      >
        <Heading subtitle={`The next ${DAYS_AHEAD} days`}>Schedule</Heading>
        {classes.isError ? <Notice tone="error">{describeError(classes.error)}</Notice> : null}
        {classes.data && byDay.size === 0 ? (
          <BodyText muted>No classes in the next two weeks.</BodyText>
        ) : null}
        {[...byDay.entries()].map(([day, sessions]) => (
          <View key={day} style={{ gap: spacing[3] }}>
            <Text
              accessibilityRole="header"
              style={[textStyle(typography.label), { color: palette.textPrimary }]}
            >
              {dayOf(sessions[0]!.scheduledStart)}
            </Text>
            {sessions.map((s) => (
              <ClassCard key={s.id} session={s} onPress={() => navigation.navigate('Class', { id: s.id })} />
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
