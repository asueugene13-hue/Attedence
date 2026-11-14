import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChoiceChips } from '../components/choice-chips';
import { BodyText, Button, Card, Heading, Notice, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

export interface FeedItem {
  id: string;
  kind: 'OFFICIAL' | 'COURSE_REP';
  title: string;
  body: string;
  sentAt: string;
  author: string;
  audience: string;
  read: boolean;
}
type Filter = 'ALL' | 'OFFICIAL' | 'COURSE_REP';

/**
 * Announcements for the signed-in person (as on the design canvas). Shown as plain text only. Opening
 * this screen marks what is shown as read. Any announcement can be reported; a moderator reviews it.
 */
export function AnnouncementsScreen() {
  const { call } = useAuth();
  const queryClient = useQueryClient();
  const { palette, spacing } = useTheme();
  const [filter, setFilter] = useState<Filter>('ALL');
  const feed = useQuery({
    queryKey: ['announcements', filter],
    queryFn: () =>
      call<{ data: FeedItem[] }>(`/me/announcements?limit=50${filter === 'ALL' ? '' : `&kind=${filter}`}`),
  });
  useEffect(() => {
    const unread = feed.data?.data.filter((a) => !a.read) ?? [];
    if (unread.length === 0) return;
    void Promise.all(unread.map((a) => call(`/me/announcements/${a.id}/read`, { method: 'POST' }))).then(() =>
      queryClient.invalidateQueries({ queryKey: ['announcements-unread'] }),
    );
  }, [feed.data, call, queryClient]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[5], gap: spacing[4] }}
        refreshControl={<RefreshControl refreshing={feed.isFetching} onRefresh={() => void feed.refetch()} />}
      >
        <Heading>Announcements</Heading>
        <ChoiceChips
          choices={[
            ['ALL', 'All'],
            ['OFFICIAL', 'Official'],
            ['COURSE_REP', 'Course reps'],
          ]}
          value={filter}
          onChange={setFilter}
        />
        {feed.isPending ? <BodyText muted>Loading…</BodyText> : null}
        {feed.isError ? <Notice tone="error">{describeError(feed.error)}</Notice> : null}
        {feed.data?.data.length === 0 ? <BodyText muted>No announcements yet.</BodyText> : null}
        {feed.data?.data.map((a) => (
          <AnnouncementCard key={a.id} item={a} />
        ))}
        <BodyText muted>
          Announcements are text only. Report one if it is offensive or misleading; a moderator reviews it.
        </BodyText>
      </ScrollView>
    </SafeAreaView>
  );
}

function AnnouncementCard({ item }: { item: FeedItem }) {
  const { call } = useAuth();
  const { palette, radius } = useTheme();
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  return (
    <Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {item.kind === 'OFFICIAL' ? (
          <Text style={{ color: palette.primary, fontWeight: '600', fontSize: 12 }}>Official</Text>
        ) : (
          <Text
            style={{
              color: palette.textSecondary,
              fontWeight: '600',
              fontSize: 12,
              borderWidth: 1,
              borderColor: palette.border,
              borderRadius: radius.badge,
              paddingHorizontal: 6,
            }}
          >
            Course rep
          </Text>
        )}
        <Text style={{ color: palette.textMuted, fontSize: 12 }}>
          {`${item.audience} · ${item.author} · ${new Date(item.sentAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}`}
        </Text>
      </View>
      <Text style={{ color: palette.textPrimary, fontSize: 16, fontWeight: '600' }}>{item.title}</Text>
      <Text style={{ color: palette.textPrimary, fontSize: 14, lineHeight: 21 }}>{item.body}</Text>
      {state.done ? (
        <BodyText muted>Reported. A moderator will review it.</BodyText>
      ) : reporting ? (
        <View style={{ gap: 8 }}>
          <TextField label="What is wrong?" value={reason} onChangeText={setReason} maxLength={500} />
          {state.error ? <Notice tone="error">{state.error}</Notice> : null}
          <Button
            label="Send report"
            variant="secondary"
            busy={state.busy}
            disabled={reason.trim().length < 5}
            onPress={() => {
              setState({ busy: true });
              call(`/announcements/${item.id}/report`, { method: 'POST', body: { reason: reason.trim() } })
                .then(() => setState({ done: true }))
                .catch((e: unknown) => setState({ error: describeError(e) }));
            }}
          />
        </View>
      ) : (
        <Button label="Report" variant="secondary" onPress={() => setReporting(true)} />
      )}
    </Card>
  );
}
