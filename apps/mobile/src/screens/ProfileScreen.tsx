import { ROLE_LABELS, type RoleKey } from '@attendsure/shared';
import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ThisPhone } from '../components/this-phone';
import { Button, Card, Heading, Notice, Screen } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';

export function ProfileScreen() {
  const auth = useAuth();
  const navigation = useNavigation<RootNavigation>();
  const { palette } = useTheme();
  const [busy, setBusy] = useState<RoleKey | 'logout' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!auth.me) return null;
  const { user, roles, activeRole } = auth.me;

  async function switchTo(role: RoleKey) {
    setBusy(role);
    setError(null);
    try {
      await auth.switchRole(role);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  const row = (label: string, value: string) => (
    <View style={{ gap: 2 }}>
      <Text style={{ color: palette.textMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: palette.textPrimary, fontSize: 15 }}>{value}</Text>
    </View>
  );

  return (
    <Screen>
      <Heading>Profile</Heading>
      <Card>
        {row('Name', user.fullName)}
        {row('Email', user.email)}
        {row('Acting as', ROLE_LABELS[activeRole])}
      </Card>
      <ThisPhone />
      <Card>
        <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Classroom tools</Text>
        <Button
          label="Check this classroom"
          variant="secondary"
          onPress={() => navigation.navigate('CheckClassroom')}
        />
        {auth.me.permissions.includes('beacons.manage') ? (
          <Button label="Beacon survey" variant="secondary" onPress={() => navigation.navigate('Survey')} />
        ) : null}
      </Card>
      {roles.length > 1 ? (
        <Card>
          <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Switch role</Text>
          {roles
            .filter((r) => r !== activeRole)
            .map((role) => (
              <Button
                key={role}
                label={`Act as ${ROLE_LABELS[role]}`}
                variant="secondary"
                busy={busy === role}
                onPress={() => switchTo(role)}
              />
            ))}
        </Card>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button
        label="Sign out"
        variant="secondary"
        busy={busy === 'logout'}
        onPress={() => {
          setBusy('logout');
          void auth.logout();
        }}
      />
    </Screen>
  );
}
