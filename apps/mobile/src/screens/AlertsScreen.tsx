import { useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BodyText, Button, Heading, Notice } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dayOf, type Notification, timeOf } from '../lib/classes';
import { textStyle, useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';

/** The person's notifications. Opening one marks it read and goes to its class. */
export function AlertsScreen() {
  const { call } = useAuth();
  const queryClient = useQueryClient();
  const navigation = useNavigation<RootNavigation>();
  const { palette, radius, spacing, typography } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: () => call<{ data: Notification[] }>('/me/notifications?limit=50'),
    refetchInterval: 60_000,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      queryClient.invalidateQueries({ queryKey: ['unread-count'] }),
    ]);

  async function open(n: Notification) {
    setError(null);
    try {
      if (!n.readAt) await call(`/me/notifications/${n.id}/read`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    }
    const sessionId = n.data?.sessionId ?? n.data?.path?.match(/^\/classes\/([0-9a-f-]+)$/)?.[1];
    if (sessionId) navigation.navigate('Class', { id: sessionId });
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[5], gap: spacing[4] }}
        refreshControl={<RefreshControl refreshing={list.isFetching} onRefresh={() => void list.refetch()} />}
      >
        <Heading subtitle="Messages about your classes">Alerts</Heading>
        {list.isError ? <Notice tone="error">{describeError(list.error)}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {list.data?.data.length === 0 ? <BodyText muted>No notifications yet.</BodyText> : null}
        {list.data?.data.some((n) => !n.readAt) ? (
          <Button
            label="Mark all as read"
            variant="secondary"
            onPress={() =>
              void call('/me/notifications/read-all', { method: 'POST' })
                .then(refresh)
                .catch((e: unknown) => setError(describeError(e)))
            }
          />
        ) : null}
        {list.data?.data.map((n) => (
          <Pressable
            key={n.id}
            accessibilityRole="button"
            accessibilityLabel={`${n.readAt ? '' : 'Unread. '}${n.title}`}
            onPress={() => void open(n)}
            style={{
              backgroundColor: palette.surface,
              borderColor: n.readAt ? palette.border : palette.primary,
              borderWidth: 1,
              borderRadius: radius.card,
              padding: spacing[4],
              gap: 4,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={[textStyle(typography.label), { color: palette.textPrimary, flexShrink: 1 }]}>
                {n.title}
              </Text>
              {!n.readAt ? (
                <Text style={{ color: palette.primary, fontSize: 12, fontWeight: '600' }}>New</Text>
              ) : null}
            </View>
            <Text style={[textStyle(typography.body), { color: palette.textSecondary }]}>{n.body}</Text>
            <Text style={{ color: palette.textMuted, fontSize: 12 }}>
              {dayOf(n.createdAt)}, {timeOf(n.createdAt)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
