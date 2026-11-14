import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Pill, RowLink } from '../components/phase6';
import { BodyText, Button, Card, Heading, Notice } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  classWhen,
  type Dispute,
  EXCUSE_CATEGORY_LABELS,
  type Excuse,
  REQUEST_STATUS,
} from '../lib/requests';
import { useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';

/** The student's disputes and excuse requests, newest first, with where each stands. */
export function MyRequestsScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { call } = useAuth();
  const { palette, spacing } = useTheme();
  const requests = useQuery({
    queryKey: ['my-requests'],
    queryFn: async () => {
      const [disputes, excuses] = await Promise.all([
        call<{ data: Dispute[] }>('/disputes?state=ALL'),
        call<{ data: Excuse[] }>('/excuse-requests?state=ALL'),
      ]);
      return [
        ...disputes.data.map((d) => ({ kind: 'dispute' as const, at: d.submittedAt, d })),
        ...excuses.data.map((e) => ({ kind: 'excuse' as const, at: e.submittedAt, e })),
      ].sort((a, b) => b.at.localeCompare(a.at));
    },
  });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[5], gap: spacing[4] }}
        refreshControl={
          <RefreshControl refreshing={requests.isFetching} onRefresh={() => void requests.refetch()} />
        }
      >
        <Heading subtitle="To dispute a record, open the course in Attendance.">My requests</Heading>
        <Button label="Request an excuse" onPress={() => navigation.navigate('ExcuseForm')} />
        {requests.isPending ? <BodyText muted>Loading…</BodyText> : null}
        {requests.isError ? <Notice tone="error">{describeError(requests.error)}</Notice> : null}
        {requests.data?.length === 0 ? <BodyText muted>You have not sent any requests.</BodyText> : null}
        {requests.data && requests.data.length > 0 ? (
          <Card>
            {requests.data.map((r, i) => (
              <View
                key={r.kind === 'dispute' ? r.d.id : r.e.id}
                style={i > 0 ? { borderTopWidth: 1, borderTopColor: palette.borderSubtle } : undefined}
              >
                {r.kind === 'dispute' ? (
                  <RowLink
                    title={`Dispute · ${r.d.class?.course?.code ?? 'Class'} ${classWhen(r.d.class?.scheduledStart ?? null)}`}
                    detail={r.d.decisionNote ? `“${r.d.decisionNote}”` : undefined}
                    onPress={() => navigation.navigate('RequestDetail', { kind: 'dispute', id: r.d.id })}
                  >
                    <Pill
                      label={
                        r.d.status === 'APPROVED' && r.d.outcome
                          ? `Approved · now ${r.d.outcome.toLowerCase()}`
                          : REQUEST_STATUS[r.d.status].label
                      }
                      tone={REQUEST_STATUS[r.d.status].tone}
                    />
                  </RowLink>
                ) : (
                  <RowLink
                    title={`Excuse · ${EXCUSE_CATEGORY_LABELS[r.e.category]}, ${r.e.startDate}${r.e.endDate !== r.e.startDate ? ` to ${r.e.endDate}` : ''}`}
                    detail={`${r.e.classCount} class${r.e.classCount === 1 ? '' : 'es'}${r.e.status === 'APPROVED' ? ` · ${r.e.excusedCount} excused` : ''}`}
                    onPress={() => navigation.navigate('RequestDetail', { kind: 'excuse', id: r.e.id })}
                  >
                    <Pill label={REQUEST_STATUS[r.e.status].label} tone={REQUEST_STATUS[r.e.status].tone} />
                  </RowLink>
                )}
              </View>
            ))}
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
