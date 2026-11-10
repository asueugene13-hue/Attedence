import { useState } from 'react';
import { Text } from 'react-native';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDevice } from '../lib/device-context';
import { useTheme } from '../lib/theme';
import { BodyText, Button, Card, Notice, TextField } from './ui';

/** This phone's status as an attendance phone (D-10), and asking to switch to it. */
export function ThisPhone() {
  const { me } = useAuth();
  const { device, error, requestTrust, refresh } = useDevice();
  const { palette } = useTheme();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const isStudent = me?.permissions.includes('devices.request_replacement') ?? false;

  async function ask() {
    if (reason.trim().length < 5) return setProblem('Explain briefly, at least 5 characters.');
    setBusy(true);
    setProblem(null);
    try {
      await requestTrust(reason.trim());
      setReason('');
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>This phone</Text>
      {error ? (
        <>
          <Notice tone="error">{`This phone could not be registered: ${error}`}</Notice>
          <Button label="Try again" variant="secondary" onPress={() => void refresh()} />
        </>
      ) : !device ? (
        <BodyText muted>Registering this phone…</BodyText>
      ) : device.status === 'TRUSTED' ? (
        <Notice tone="success">
          {device.isAttendanceDevice
            ? 'This is your attendance phone. Check-ins from it can be verified automatically.'
            : 'This phone is registered to your account.'}
        </Notice>
      ) : device.status === 'PENDING_APPROVAL' ? (
        device.trustRequestedAt ? (
          <Notice tone="info">
            Your request to use this phone for attendance is waiting for the Registrar or an administrator to
            approve it.
          </Notice>
        ) : isStudent ? (
          <>
            <BodyText>
              Your attendance phone is a different phone. To use this one instead (for example, your old phone
              broke), ask for it to be approved. Your old phone then stops working for attendance.
            </BodyText>
            <TextField
              label="Why are you changing phones?"
              value={reason}
              onChangeText={setReason}
              maxLength={500}
            />
            {problem ? <Notice tone="error">{problem}</Notice> : null}
            <Button label="Use this phone for attendance" busy={busy} onPress={() => void ask()} />
          </>
        ) : (
          <BodyText muted>This phone is waiting for approval.</BodyText>
        )
      ) : (
        <Notice tone="error">
          {`This phone can no longer be used for attendance${device.revokeReason ? `: ${device.revokeReason}` : '.'} Ask the Registrar for help.`}
        </Notice>
      )}
    </Card>
  );
}
