import { type RouteProp, useRoute } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Pill } from '../components/phase6';
import { BodyText, Button, Card, Heading, Notice, Screen, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  classWhen,
  type Dispute,
  EXCUSE_CATEGORY_LABELS,
  type Excuse,
  isOpen,
  type Message,
  pickAttachment,
  RECORD_STATUS_LABELS,
  REQUEST_STATUS,
} from '../lib/requests';
import { useTheme } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

/** One dispute or excuse request: where it stands, the conversation, files, and what the student can do. */
export function RequestDetailScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'RequestDetail'>>();
  const { kind, id, notice } = route.params;
  const base = kind === 'dispute' ? `/disputes/${id}` : `/excuse-requests/${id}`;
  const queryClient = useQueryClient();
  const { call } = useAuth();
  const { palette } = useTheme();
  const request = useQuery({
    queryKey: ['my-requests', kind, id],
    queryFn: () => call<Dispute | Excuse>(base),
  });
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'reply' | 'withdraw' | 'file' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(what: 'reply' | 'withdraw' | 'file', run: () => Promise<unknown>) {
    setBusy(what);
    setError(null);
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: ['my-requests'] });
      if (what === 'reply') setReply('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  const r = request.data;
  if (!r) {
    return (
      <Screen>
        {request.isError ? (
          <Notice tone="error">{describeError(request.error)}</Notice>
        ) : (
          <BodyText muted>Loading…</BodyText>
        )}
      </Screen>
    );
  }
  const dispute = kind === 'dispute' ? (r as Dispute) : null;
  const excuse = kind === 'excuse' ? (r as Excuse) : null;
  const status = REQUEST_STATUS[r.status];
  return (
    <Screen>
      {notice ? <Notice tone="error">{notice}</Notice> : null}
      <Heading
        subtitle={`Sent ${new Date(r.submittedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`}
      >
        {dispute
          ? `Dispute · ${dispute.class?.course?.code ?? 'Class'} ${classWhen(dispute.class?.scheduledStart ?? null)}`
          : `Excuse · ${EXCUSE_CATEGORY_LABELS[excuse!.category]}`}
      </Heading>
      <Pill label={status.label} tone={status.tone} />
      {r.decisionNote ? (
        <Notice tone={r.status === 'APPROVED' ? 'success' : 'error'}>{`“${r.decisionNote}”`}</Notice>
      ) : null}
      {dispute?.status === 'APPROVED' && dispute.outcome ? (
        <BodyText>{`Your record is now ${dispute.outcome.toLowerCase()}.`}</BodyText>
      ) : null}
      <Card>
        <Text style={{ color: palette.textMuted, fontSize: 12 }}>
          {dispute ? 'What you said' : 'Details'}
        </Text>
        <BodyText>{dispute ? dispute.reason : excuse!.description}</BodyText>
      </Card>
      {excuse?.classes ? (
        <Card>
          <Text
            style={{ color: palette.textMuted, fontSize: 12 }}
          >{`Classes · ${excuse.classes.length}`}</Text>
          {excuse.classes.map((c) => (
            <View
              key={c.classSessionId}
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}
            >
              <BodyText>{`${c.course?.code ?? 'Class'} · ${classWhen(c.scheduledStart)}`}</BodyText>
              <Text style={{ color: palette.textSecondary, fontSize: 13 }}>
                {c.included === false
                  ? 'Not excused'
                  : c.recordStatus
                    ? (RECORD_STATUS_LABELS[c.recordStatus] ?? c.recordStatus)
                    : 'Not recorded yet'}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}
      {r.messages && r.messages.length > 0 ? <Conversation messages={r.messages} /> : null}
      {r.status === 'INFO_REQUESTED' ? (
        <Card>
          <TextField
            label="Your reply"
            multiline
            value={reply}
            onChangeText={setReply}
            maxLength={2000}
            style={{ minHeight: 80, textAlignVertical: 'top', paddingTop: 12 }}
          />
          <Button
            label="Send reply"
            busy={busy === 'reply'}
            disabled={reply.trim().length < 2}
            onPress={() =>
              void act('reply', () =>
                call(`${base}/respond`, { method: 'POST', body: { reply: reply.trim() } }),
              )
            }
          />
        </Card>
      ) : null}
      {r.attachments && r.attachments.length > 0 ? (
        <Card>
          <Text style={{ color: palette.textMuted, fontSize: 12 }}>Files</Text>
          {r.attachments.map((a) => (
            <BodyText key={a.fileId}>{`${a.name ?? 'File'} · ${Math.ceil(a.sizeBytes / 1024)} KB`}</BodyText>
          ))}
        </Card>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {isOpen(r.status) ? (
        <>
          {(r.attachments?.length ?? 0) < 3 ? (
            <Button
              label="Add a file"
              variant="secondary"
              busy={busy === 'file'}
              onPress={() =>
                void (async () => {
                  const picked = await pickAttachment();
                  if (picked && 'tooBig' in picked) setError('That file is larger than 10 MB.');
                  else if (picked) {
                    await act('file', () =>
                      call(`${base}/attachments`, { method: 'POST', form: picked.form }),
                    );
                  }
                })()
              }
            />
          ) : null}
          <Button
            label="Withdraw"
            variant="secondary"
            busy={busy === 'withdraw'}
            onPress={() => void act('withdraw', () => call(`${base}/withdraw`, { method: 'POST' }))}
          />
        </>
      ) : null}
    </Screen>
  );
}

function Conversation({ messages }: { messages: Message[] }) {
  const { palette, radius } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      {messages.map((m) => (
        <View
          key={`${m.at}-${m.kind}`}
          style={{
            backgroundColor: m.kind === 'QUESTION' ? palette.surface : palette.primaryTint,
            borderRadius: radius.control,
            borderWidth: 1,
            borderColor: palette.borderSubtle,
            padding: 10,
            gap: 4,
          }}
        >
          <Text style={{ color: palette.textSecondary, fontSize: 12, fontWeight: '600' }}>
            {`${m.kind === 'QUESTION' ? `${m.by} asked` : 'You replied'} · ${new Date(m.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`}
          </Text>
          <Text style={{ color: palette.textPrimary, fontSize: 14, lineHeight: 20 }}>{m.body}</Text>
        </View>
      ))}
    </View>
  );
}
