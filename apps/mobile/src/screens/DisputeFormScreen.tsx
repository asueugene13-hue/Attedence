import { type RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Pill } from '../components/phase6';
import { BodyText, Button, Card, Notice, Screen, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type Dispute, pickAttachment, RECORD_STATUS_LABELS } from '../lib/requests';
import { useTheme } from '../lib/theme';
import type { RootNavigation, RootStackParamList } from '../navigation/types';

/**
 * Dispute an absent or rejected record (as on the design canvas). The record stays as it is until the
 * lecturer (or, after 3 days, an administrator) decides. A supporting file is optional.
 */
export function DisputeFormScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'DisputeForm'>>();
  const navigation = useNavigation<RootNavigation>();
  const queryClient = useQueryClient();
  const { call } = useAuth();
  const { palette } = useTheme();
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<{ form: FormData; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = reason.trim().length < 10;

  async function choose() {
    setError(null);
    const picked = await pickAttachment();
    if (picked && 'tooBig' in picked) setError('That file is larger than 10 MB.');
    else if (picked) setFile(picked);
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const dispute = await call<Dispute>('/disputes', {
        method: 'POST',
        body: { classSessionId: route.params.classSessionId, reason: reason.trim() },
      });
      // The dispute is sent; a failed upload is reported on the dispute's own screen, where it can be retried.
      let notice: string | undefined;
      if (file) {
        try {
          await call(`/disputes/${dispute.id}/attachments`, { method: 'POST', form: file.form });
        } catch (e) {
          notice = `Your dispute was sent, but the file was not attached: ${describeError(e)}`;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['my-requests'] });
      navigation.replace('RequestDetail', { kind: 'dispute', id: dispute.id, notice });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <Text style={{ color: palette.textPrimary, fontWeight: '600', flexShrink: 1 }}>
            {route.params.title}
          </Text>
          <Pill label={RECORD_STATUS_LABELS[route.params.status] ?? route.params.status} tone="error" />
        </View>
      </Card>
      <TextField
        label="What happened? (required)"
        multiline
        value={reason}
        onChangeText={setReason}
        maxLength={2000}
        placeholder="For example: I was in the room from 09:55. My phone would not confirm. The lecturer saw me."
        style={{ minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }}
      />
      <Button
        label={file ? `Attached: ${file.name} (change)` : 'Add a photo or PDF (optional)'}
        variant="secondary"
        onPress={() => void choose()}
      />
      <BodyText muted>PDF, JPG or PNG, up to 10 MB.</BodyText>
      <Notice tone="info">
        Your lecturer decides. If there is no decision within 3 days, an administrator decides. Your record
        stays as it is until then, and you will be told the outcome.
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label="Send dispute" busy={busy} disabled={tooShort} onPress={() => void send()} />
      {tooShort ? <BodyText muted>Explain in at least 10 characters.</BodyText> : null}
    </Screen>
  );
}
