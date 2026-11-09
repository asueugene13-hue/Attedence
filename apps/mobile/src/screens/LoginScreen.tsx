import { useState } from 'react';
import { BodyText, Brand, Button, Heading, Notice, Screen, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginScreen() {
  const auth = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await auth.login(identifier.trim(), password);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Brand />
      <Heading subtitle="Use your Student ID or the email address the university registered for you.">
        Sign in
      </Heading>
      <TextField
        label="Email or Student ID"
        value={identifier}
        onChangeText={setIdentifier}
        autoCapitalize="none"
        autoComplete="username"
        textContentType="username"
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={submit}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label="Sign in" onPress={submit} busy={busy} disabled={!identifier || !password} />
      <BodyText muted>
        New account? Open the activation link from your email to choose a password first. Forgotten passwords
        are reset from the same email.
      </BodyText>
    </Screen>
  );
}
