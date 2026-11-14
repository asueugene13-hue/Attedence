import { EXCUSE_CATEGORIES } from '@attendsure/shared';
import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ChoiceChips } from '../components/choice-chips';
import { BodyText, Button, Card, Notice, Screen, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDay } from '../lib/classes';
import {
  classWhen,
  EXCUSE_CATEGORY_LABELS,
  type Excuse,
  type ExcuseCategory,
  pickAttachment,
  RECORD_STATUS_LABELS,
} from '../lib/requests';
import { useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';

interface Covered {
  classSessionId: string;
  scheduledStart: string;
  course: { code: string; title: string } | null;
  recordStatus: string | null;
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ask to be excused from the classes in some dates (as on the design canvas). The server lists the
 * classes; the student can untick any. Only administrators see the reason and the files (D-22).
 */
export function ExcuseFormScreen() {
  const navigation = useNavigation<RootNavigation>();
  const queryClient = useQueryClient();
  const { call } = useAuth();
  const { palette, radius } = useTheme();
  const today = localDay();
  const [category, setCategory] = useState<ExcuseCategory | null>(null);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [classes, setClasses] = useState<Covered[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<{ form: FormData; name: string }[]>([]);
  const [busy, setBusy] = useState<'find' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    if (!DATE.test(startDate) || !DATE.test(endDate)) {
      setError('Write the dates as year-month-day, for example 2030-08-20.');
      return;
    }
    setBusy('find');
    setError(null);
    try {
      const found = await call<{ data: Covered[] }>(
        `/excuse-requests/covered?startDate=${startDate}&endDate=${endDate}`,
      );
      setClasses(found.data);
      setChosen(new Set(found.data.map((c) => c.classSessionId)));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function addFile() {
    setError(null);
    const picked = await pickAttachment();
    if (picked && 'tooBig' in picked) setError('That file is larger than 10 MB.');
    else if (picked) setFiles((f) => [...f, picked].slice(0, 3));
  }

  async function send() {
    setBusy('send');
    setError(null);
    try {
      const excuse = await call<Excuse>('/excuse-requests', {
        method: 'POST',
        body: {
          category,
          startDate,
          endDate,
          description: description.trim(),
          classSessionIds: [...chosen],
        },
      });
      let notice: string | undefined;
      for (const f of files) {
        try {
          await call(`/excuse-requests/${excuse.id}/attachments`, { method: 'POST', form: f.form });
        } catch (e) {
          notice = `Your request was sent, but ${f.name} was not attached: ${describeError(e)}`;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['my-requests'] });
      navigation.replace('RequestDetail', { kind: 'excuse', id: excuse.id, notice });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  const ready = category !== null && chosen.size > 0 && description.trim().length >= 10;
  return (
    <Screen>
      <BodyText>Reason for absence</BodyText>
      <ChoiceChips
        choices={EXCUSE_CATEGORIES.map((c) => [c, EXCUSE_CATEGORY_LABELS[c]] as const)}
        value={category}
        onChange={setCategory}
      />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <TextField
            label="From"
            value={startDate}
            onChangeText={(v) => {
              setStartDate(v);
              setClasses(null);
            }}
            placeholder="2030-08-20"
            autoCapitalize="none"
          />
        </View>
        <View style={{ flex: 1 }}>
          <TextField
            label="To"
            value={endDate}
            onChangeText={(v) => {
              setEndDate(v);
              setClasses(null);
            }}
            placeholder="2030-08-21"
            autoCapitalize="none"
          />
        </View>
      </View>
      <Button
        label="Find my classes in these dates"
        variant="secondary"
        busy={busy === 'find'}
        onPress={() => void find()}
      />
      {classes ? (
        <Card>
          <Text
            style={{ color: palette.textSecondary, fontWeight: '600' }}
          >{`Classes in these dates · ${classes.length}`}</Text>
          {classes.length === 0 ? <BodyText muted>You have no classes in these dates.</BodyText> : null}
          {classes.map((c) => {
            const on = chosen.has(c.classSessionId);
            return (
              <Pressable
                key={c.classSessionId}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${c.course?.code ?? 'Class'} ${classWhen(c.scheduledStart)}`}
                onPress={() =>
                  setChosen((s) => {
                    const next = new Set(s);
                    if (on) next.delete(c.classSessionId);
                    else next.add(c.classSessionId);
                    return next;
                  })
                }
                style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: radius.badge,
                    borderWidth: 2,
                    borderColor: palette.primary,
                    backgroundColor: on ? palette.primary : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {on ? (
                    <Text style={{ color: palette.onPrimary, fontSize: 14, fontWeight: '700' }}>✓</Text>
                  ) : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>
                    {c.course ? `${c.course.code} · ${c.course.title}` : 'Class'}
                  </Text>
                  <Text style={{ color: palette.textMuted, fontSize: 12 }}>
                    {`${classWhen(c.scheduledStart)}${c.recordStatus ? ` · ${RECORD_STATUS_LABELS[c.recordStatus] ?? c.recordStatus}` : ''}`}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </Card>
      ) : null}
      <TextField
        label="Details (required)"
        multiline
        value={description}
        onChangeText={setDescription}
        maxLength={2000}
        placeholder="A short explanation"
        style={{ minHeight: 96, textAlignVertical: 'top', paddingTop: 12 }}
      />
      {files.map((f) => (
        <BodyText key={f.name} muted>{`Attached: ${f.name}`}</BodyText>
      ))}
      {files.length < 3 ? (
        <Button
          label={files.length ? 'Add another file' : 'Add documents (optional)'}
          variant="secondary"
          onPress={() => void addFile()}
        />
      ) : null}
      <Notice tone="info">
        Only the administrators who decide see your reason and documents. Your lecturers see only “Excused”.
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label="Send request" busy={busy === 'send'} disabled={!ready} onPress={() => void send()} />
      {!ready ? (
        <BodyText muted>
          Choose a reason, find and keep at least one class, and explain in 10 characters or more.
        </BodyText>
      ) : null}
    </Screen>
  );
}
