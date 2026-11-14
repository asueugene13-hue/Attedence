import { ANNOUNCEMENT_LIMITS } from '@attendsure/shared';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BodyText, Button, Card, Notice, Screen, TextField } from '../components/ui';
import { describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

interface Targets {
  kind: 'OFFICIAL' | 'COURSE_REP';
  /** Course reps: updates a section may receive per day. */
  dailyLimit?: number;
  sections: {
    id: string;
    code: string;
    course: { code: string; title: string };
    students: number;
    remainingToday?: number;
  }[];
}

/**
 * A lecturer's announcement to their sections, or a course rep's update to their section (labelled
 * "Course rep", at most 3 a day per section). Plain text. Administrators send theirs on the web.
 */
export function AnnouncementComposeScreen() {
  const navigation = useNavigation();
  const { call } = useAuth();
  const { palette, radius } = useTheme();
  const targets = useQuery({
    queryKey: ['announcement-targets'],
    queryFn: () => call<Targets>('/announcements/targets'),
  });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  const t = targets.data;
  const recipients = t?.sections.filter((s) => chosen.has(s.id)).reduce((n, s) => n + s.students, 0) ?? 0;
  const ready = chosen.size > 0 && title.trim().length >= 3 && body.trim().length > 0;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ counts: { recipients: number } }>('/announcements', {
        method: 'POST',
        body: { scope: 'SECTION', sectionIds: [...chosen], title: title.trim(), body: body.trim(), email },
      });
      setSent(result.counts.recipients);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent !== null) {
    return (
      <Screen>
        <Notice tone="success">{`Sent to ${sent} student${sent === 1 ? '' : 's'}.`}</Notice>
        <Button label="Done" onPress={() => navigation.goBack()} />
      </Screen>
    );
  }
  return (
    <Screen>
      {targets.isError ? <Notice tone="error">{describeError(targets.error)}</Notice> : null}
      {t && t.sections.length === 0 ? (
        <Notice tone="info">
          {t.kind === 'COURSE_REP'
            ? 'You are not the course rep of any section right now.'
            : 'You are not teaching any section right now.'}
        </Notice>
      ) : null}
      {t && t.sections.length > 0 ? (
        <Card>
          <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Send to</Text>
          {t.sections.map((s) => {
            const on = chosen.has(s.id);
            const full = s.remainingToday !== undefined && s.remainingToday <= 0;
            return (
              <Pressable
                key={s.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: full }}
                accessibilityLabel={`${s.course.code} ${s.code}`}
                disabled={full}
                onPress={() =>
                  setChosen((c) => {
                    const next = new Set(c);
                    if (on) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
                style={{
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  opacity: full ? 0.55 : 1,
                }}
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
                  {on ? <Text style={{ color: palette.onPrimary, fontWeight: '700' }}>✓</Text> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{ color: palette.textPrimary }}
                  >{`${s.course.code} · ${s.code} · ${s.course.title}`}</Text>
                  <Text style={{ color: palette.textMuted, fontSize: 12 }}>
                    {`${s.students} students${s.remainingToday !== undefined ? ` · ${Math.max(s.remainingToday, 0)} of ${t.dailyLimit ?? s.remainingToday} updates left today` : ''}`}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </Card>
      ) : null}
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        maxLength={ANNOUNCEMENT_LIMITS.titleMax}
      />
      <TextField
        label="Message"
        multiline
        value={body}
        onChangeText={setBody}
        maxLength={ANNOUNCEMENT_LIMITS.bodyMax}
        style={{ minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }}
      />
      <BodyText muted>{`Plain text · ${body.length} / ${ANNOUNCEMENT_LIMITS.bodyMax}`}</BodyText>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: email }}
        onPress={() => setEmail((e) => !e)}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: radius.badge,
            borderWidth: 2,
            borderColor: palette.primary,
            backgroundColor: email ? palette.primary : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {email ? <Text style={{ color: palette.onPrimary, fontWeight: '700' }}>✓</Text> : null}
        </View>
        <Text style={{ color: palette.textPrimary, flex: 1 }}>
          Also email it to students who get announcement emails
        </Text>
      </Pressable>
      {t ? (
        <BodyText muted>
          {`${recipients} student${recipients === 1 ? '' : 's'} will see this. It is labelled ${t.kind === 'COURSE_REP' ? '“Course rep”' : '“Official”'}.`}
        </BodyText>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label="Send announcement" busy={busy} disabled={!ready} onPress={() => void send()} />
    </Screen>
  );
}
