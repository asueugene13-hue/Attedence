import { ROLE_LABELS } from '@attendsure/shared';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ClassCard } from '../components/class-card';
import { BodyText, Heading, Notice } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type ClassSession, localDay } from '../lib/classes';
import { useTheme } from '../lib/theme';
import { WEB_DASHBOARD_ROLES } from '../navigation/tabs';
import type { RootNavigation } from '../navigation/types';

/** Today's classes for a student or lecturer; staff are pointed to the web dashboard. */
export function HomeScreen() {
  const { me, call } = useAuth();
  const navigation = useNavigation<RootNavigation>();
  const { palette, spacing } = useTheme();
  const today = localDay();
  const role = me?.activeRole;
  const usesTimetable = role === 'STUDENT' || role === 'COURSE_REP' || role === 'LECTURER';
  const classes = useQuery({
    queryKey: ['my-timetable', today, today],
    enabled: usesTimetable,
    queryFn: () => call<{ data: ClassSession[] }>(`/me/timetable?from=${today}&to=${today}`),
    refetchInterval: 60_000,
  });
  if (!me || !role) return null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[5], gap: spacing[5] }}
        refreshControl={
          usesTimetable ? (
            <RefreshControl refreshing={classes.isFetching} onRefresh={() => void classes.refetch()} />
          ) : undefined
        }
      >
        <Heading subtitle={`Signed in as ${ROLE_LABELS[role]}`}>{`Hello, ${me.user.fullName}`}</Heading>
        {WEB_DASHBOARD_ROLES.includes(role) ? (
          <Notice tone="info">
            {ROLE_LABELS[role]} tools are on the AttendSure web dashboard. If you also teach or study, switch
            role in Profile.
          </Notice>
        ) : (
          <View style={{ gap: spacing[3] }}>
            <BodyText>Today</BodyText>
            {classes.isError ? <Notice tone="error">{describeError(classes.error)}</Notice> : null}
            {classes.data?.data.length === 0 ? <BodyText muted>No classes today.</BodyText> : null}
            {classes.data?.data.map((s) => (
              <ClassCard key={s.id} session={s} onPress={() => navigation.navigate('Class', { id: s.id })} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
