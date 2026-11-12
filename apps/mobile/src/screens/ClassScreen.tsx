import { CANCEL_REASONS, CLASS_ACTIONS, type ClassActionName, ISSUE_TYPES } from '@attendsure/shared';
import { type RouteProp, useRoute } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StatusPill } from '../components/class-card';
import { LecturerAttendance } from '../components/lecturer-attendance';
import { BodyText, Button, Card, Heading, Notice, Screen, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type ClassSession, classLabel, classTimes, dayOf } from '../lib/classes';
import { useTheme } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

const ISSUE_LABELS: Record<(typeof ISSUE_TYPES)[number], string> = {
  LECTURER_NOT_ARRIVED: 'Lecturer has not arrived',
  VERBAL_CANCELLATION: 'Lecturer cancelled verbally',
  CLASS_DELAYED: 'Class is delayed',
  WRONG_CLASSROOM: 'Wrong classroom',
  VENUE_PROBLEM: 'Problem with the room',
  TIMETABLE_ERROR: 'Timetable error',
  TECHNICAL_PROBLEM: 'Technical problem',
  OTHER: 'Other',
};
const CANCEL_LABELS: Partial<Record<(typeof CANCEL_REASONS)[number], string>> = {
  LECTURER_UNAVAILABLE: 'I am unavailable',
  ILLNESS: 'Illness',
  OFFICIAL_DUTY: 'Official duty',
  VENUE_UNAVAILABLE: 'Room unavailable',
  EMERGENCY: 'Emergency',
  OTHER: 'Other (explain)',
};
/** Lecturer actions shown on the phone; holds, voids and review decisions stay on the dashboard. */
const PHONE_ACTIONS: ClassActionName[] = [
  'confirm',
  'start',
  'resume',
  'end',
  'interrupt',
  'delay',
  'cancel',
];
const CLOSED = ['COMPLETED', 'CANCELLED', 'RESCHEDULED'];

type Form = { kind: 'delay' } | { kind: 'cancel' } | { kind: 'interrupt' } | { kind: 'report' } | null;

export function ClassScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Class'>>();
  const { call, me } = useAuth();
  const queryClient = useQueryClient();
  const id = route.params.id;
  const session = useQuery({
    queryKey: ['class', id],
    queryFn: () => call<ClassSession>(`/class-sessions/${id}`),
  });
  const [form, setForm] = useState<Form>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (session.isPending) {
    return (
      <Screen>
        <BodyText muted>Loading…</BodyText>
      </Screen>
    );
  }
  if (session.isError) {
    return (
      <Screen>
        <Notice tone="error">{describeError(session.error)}</Notice>
      </Screen>
    );
  }
  const s = session.data;
  const isOwnLecturer = me?.activeRole === 'LECTURER' && s.lecturer?.userId === me.user.id;
  const isStudent = me?.activeRole === 'STUDENT' || me?.activeRole === 'COURSE_REP';
  const actions = isOwnLecturer
    ? PHONE_ACTIONS.filter((a) => (CLASS_ACTIONS[a].lecturerFrom as readonly string[]).includes(s.status))
    : [];
  const canReport = (isOwnLecturer || isStudent) && !CLOSED.includes(s.status);

  async function send(path: string, body: object, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call(path, { method: 'POST', body });
      setNotice(done);
      setForm(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['class', id] }),
        queryClient.invalidateQueries({ queryKey: ['my-timetable'] }),
      ]);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const act = (action: ClassActionName, body: object = {}) =>
    send(`/class-sessions/${id}/${action}`, body, `${CLASS_ACTIONS[action].label}: done.`);

  return (
    <Screen>
      <Heading subtitle={s.sections.map((x) => x.course.title).join(' · ')}>{classLabel(s)}</Heading>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <BodyText>{dayOf(s.scheduledStart)}</BodyText>
          <StatusPill status={s.status} />
        </View>
        <BodyText>{classTimes(s)}</BodyText>
        <BodyText>
          {s.classroom ? `${s.classroom.code} · ${s.classroom.name}` : 'Room to be confirmed'}
        </BodyText>
        <BodyText muted>{s.lecturer ? `Lecturer: ${s.lecturer.fullName}` : ''}</BodyText>
        {s.cancelReason ? (
          <Notice tone="error">{`Cancelled${s.cancelNote ? `: ${s.cancelNote}` : '.'}`}</Notice>
        ) : null}
        {s.status === 'UNDER_REVIEW' ? (
          <Notice tone="info">
            The university is checking on this class. You will be told what happens.
          </Notice>
        ) : null}
        {isOwnLecturer && s.status === 'UNCONFIRMED' ? (
          <Notice tone="error">Your class has not started. What is happening? Choose an action below.</Notice>
        ) : null}
      </Card>

      {isOwnLecturer ? <LecturerAttendance classId={s.id} classStatus={s.status} /> : null}

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {form === null ? (
        <View style={{ gap: 12 }}>
          {actions.map((a) => (
            <Button
              key={a}
              label={CLASS_ACTIONS[a].label}
              variant={a === 'start' ? 'primary' : 'secondary'}
              busy={busy}
              onPress={() =>
                a === 'delay' || a === 'cancel' || a === 'interrupt' ? setForm({ kind: a }) : void act(a)
              }
            />
          ))}
          {canReport ? (
            <Button
              label="Report a problem"
              variant="secondary"
              onPress={() => setForm({ kind: 'report' })}
            />
          ) : null}
        </View>
      ) : null}

      {form?.kind === 'delay' ? (
        <DelayForm busy={busy} onCancel={() => setForm(null)} onSubmit={(b) => act('delay', b)} />
      ) : null}
      {form?.kind === 'interrupt' ? (
        <ReasonForm
          title="Report an interruption"
          busy={busy}
          onCancel={() => setForm(null)}
          onSubmit={(reason) => act('interrupt', { reason })}
        />
      ) : null}
      {form?.kind === 'cancel' ? (
        <ChoiceForm
          title="Why are you cancelling?"
          choices={Object.entries(CANCEL_LABELS) as [string, string][]}
          noteRequiredFor="OTHER"
          submitLabel="Cancel class"
          busy={busy}
          onCancel={() => setForm(null)}
          onSubmit={(reasonCode, note) => act('cancel', { reasonCode, ...(note ? { note } : {}) })}
        />
      ) : null}
      {form?.kind === 'report' ? (
        <ChoiceForm
          title="What is wrong?"
          choices={ISSUE_TYPES.map((t) => [t, ISSUE_LABELS[t]] as [string, string])}
          submitLabel="Send report"
          busy={busy}
          onCancel={() => setForm(null)}
          onSubmit={(type, note) =>
            send(
              `/class-sessions/${id}/issue-reports`,
              { type, ...(note ? { note } : {}) },
              'Thank you. Your report was recorded and the class will be checked.',
            )
          }
        />
      ) : null}
    </Screen>
  );
}

function DelayForm(props: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: object) => Promise<void>;
}) {
  const [minutes, setMinutes] = useState('15');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card>
      <BodyText>Students are told the new start time at once.</BodyText>
      <TextField label="Minutes late" keyboardType="number-pad" value={minutes} onChangeText={setMinutes} />
      <TextField label="Reason" value={reason} onChangeText={setReason} maxLength={500} />
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <Button
        label="Report delay"
        busy={props.busy}
        onPress={() => {
          const n = Number(minutes);
          if (!Number.isInteger(n) || n < 5 || n > 240) return setProblem('The delay is 5 to 240 minutes.');
          if (reason.trim().length < 5) return setProblem('Explain briefly, at least 5 characters.');
          void props.onSubmit({ minutes: n, reason: reason.trim() });
        }}
      />
      <Button label="Back" variant="secondary" onPress={props.onCancel} />
    </Card>
  );
}

function ReasonForm(props: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card>
      <BodyText>{props.title}</BodyText>
      <TextField label="Reason" value={reason} onChangeText={setReason} maxLength={500} />
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <Button
        label={props.title}
        busy={props.busy}
        onPress={() =>
          reason.trim().length < 5
            ? setProblem('Explain briefly, at least 5 characters.')
            : void props.onSubmit(reason.trim())
        }
      />
      <Button label="Back" variant="secondary" onPress={props.onCancel} />
    </Card>
  );
}

function ChoiceForm(props: {
  title: string;
  choices: [string, string][];
  noteRequiredFor?: string;
  submitLabel: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (choice: string, note: string) => Promise<void>;
}) {
  const { palette, radius } = useTheme();
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card>
      <BodyText>{props.title}</BodyText>
      <View style={{ gap: 8 }} accessibilityRole="radiogroup">
        {props.choices.map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: choice === value }}
            accessibilityLabel={label}
            onPress={() => setChoice(value)}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: 12,
              borderWidth: 1,
              borderRadius: radius.control,
              borderColor: choice === value ? palette.primary : palette.border,
              backgroundColor: choice === value ? palette.primaryTint : palette.surface,
            }}
          >
            <Text style={{ color: palette.textPrimary }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <TextField label="Note (optional)" value={note} onChangeText={setNote} maxLength={500} />
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <Button
        label={props.submitLabel}
        busy={props.busy}
        onPress={() => {
          if (!choice) return setProblem('Choose one.');
          if (choice === props.noteRequiredFor && note.trim().length < 5)
            return setProblem('Explain briefly, at least 5 characters.');
          void props.onSubmit(choice, note.trim());
        }}
      />
      <Button label="Back" variant="secondary" onPress={props.onCancel} />
    </Card>
  );
}
