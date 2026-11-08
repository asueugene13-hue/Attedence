import { useState } from 'react';
import { Brand, Button, Heading, Notice, Screen, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Two-step sign-in for people who also hold a staff role. First-time setup (QR code and recovery codes)
 * happens on the web dashboard, where the codes can be saved safely; the app only accepts codes.
 */
export function TwoStepScreen() {
  const auth = useAuth();
  const challenge = auth.pendingMfa;
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!challenge) return null;

  if (challenge.enrollmentRequired) {
    return (
      <Screen>
        <Brand />
        <Heading subtitle="Your account has a staff role, which needs two-step sign-in.">
          Set up on the web first
        </Heading>
        <Notice tone="info">
          Sign in once on the AttendSure web dashboard to set up your authenticator app and save your recovery
          codes. Then come back and sign in here.
        </Notice>
        <Button label="Back to sign in" variant="secondary" onPress={auth.cancelMfa} />
      </Screen>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await auth.verifyMfa(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Brand />
      <Heading
        subtitle={
          useRecovery
            ? 'Enter one of the recovery codes you saved.'
            : 'Enter the 6-digit code from your authenticator app.'
        }
      >
        Two-step sign-in
      </Heading>
      <TextField
        label={useRecovery ? 'Recovery code' : '6-digit code'}
        value={code}
        onChangeText={setCode}
        keyboardType={useRecovery ? 'default' : 'number-pad'}
        autoCapitalize="characters"
        textContentType="oneTimeCode"
        maxLength={useRecovery ? 11 : 6}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label="Sign in" onPress={submit} busy={busy} disabled={!code} />
      <Button
        label={useRecovery ? 'Use a code from my app instead' : 'Lost your phone? Use a recovery code'}
        variant="secondary"
        onPress={() => {
          setUseRecovery(!useRecovery);
          setCode('');
          setError(null);
        }}
      />
      <Button label="Cancel" variant="secondary" onPress={auth.cancelMfa} />
    </Screen>
  );
}
