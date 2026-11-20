import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { BodyText, Card, Heading, Notice, Screen } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

interface Preference {
  category: string;
  label: string;
  mandatory: boolean;
  channels: { channel: 'EMAIL' | 'PUSH'; available: boolean; enabled: boolean }[];
}

/**
 * Which messages also come by email (the same settings as the web page). Every message always appears
 * under Alerts; the API lists only the kinds this person can receive.
 */
export function NotificationSettingsScreen() {
  const { call } = useAuth();
  const queryClient = useQueryClient();
  const { palette } = useTheme();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => call<{ data: Preference[] }>('/me/notification-preferences'),
  });

  async function toggle(category: string, enabled: boolean) {
    setSaving(category);
    setError(null);
    try {
      const updated = await call<{ data: Preference[] }>('/me/notification-preferences', {
        method: 'PUT',
        body: { category, channel: 'EMAIL', enabled },
      });
      queryClient.setQueryData(['notification-preferences'], updated);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Screen>
      <Heading subtitle="Every message appears under Alerts">Email settings</Heading>
      <BodyText muted>
        Choose which messages also come by email. Messages about cancelled, moved or restored classes always
        do. Phone notifications are not switched on yet.
      </BodyText>
      {prefs.isError ? <Notice tone="error">{describeError(prefs.error)}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {prefs.data ? (
        <Card>
          {prefs.data.data.map((p) => {
            const email = p.channels.find((c) => c.channel === 'EMAIL');
            if (!email) return null;
            return (
              <View
                key={p.category}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <View style={{ flexShrink: 1 }}>
                  <Text style={{ color: palette.textPrimary, fontSize: 15 }}>{p.label}</Text>
                  {p.mandatory ? (
                    <Text style={{ color: palette.textMuted, fontSize: 12 }}>Always emailed</Text>
                  ) : null}
                </View>
                <Switch
                  accessibilityLabel={`Email: ${p.label}`}
                  value={email.enabled}
                  disabled={p.mandatory || saving !== null || !email.available}
                  onValueChange={(v) => void toggle(p.category, v)}
                />
              </View>
            );
          })}
        </Card>
      ) : null}
      {prefs.data?.data.some((p) => p.channels.some((c) => c.channel === 'EMAIL' && !c.available)) ? (
        <Notice tone="info">Email is not set up on this AttendSure server yet.</Notice>
      ) : null}
    </Screen>
  );
}
