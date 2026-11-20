import { ASSIST_METHOD_LABELS, type ASSIST_METHODS } from '@attendsure/shared';
import { useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { describeError } from '../lib/api';
import { RECORD_LABELS } from '../lib/attendance';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';
import { ChoiceChips } from './choice-chips';
import { BodyText, Button, Card, Notice, TextField } from './ui';

interface AttendanceSession {
  id: string;
  status: 'OPEN' | 'CLOSED';
  closesAt: string;
  lateAfter: string;
}
interface RosterLine {
  studentId: string;
  fullName: string;
  studentNumber: string;
  status: string | null;
  recordId: string | null;
  version: number | null;
  lastAttempt: { reason: string | null } | null;
}
interface Roster {
  degraded: boolean;
  counts: Record<string, number>;
  students: RosterLine[];
}

type AssistMethod = (typeof ASSIST_METHODS)[number];
const ASSIST_CHOICES = Object.entries(ASSIST_METHOD_LABELS) as [AssistMethod, string][];
/** A hand check-in is possible only while the class is running (the API checks this too). */
const RUNNING = ['ACTIVE', 'INTERRUPTED'];
const missing = (s: RosterLine) => s.status === null || s.status === 'ABSENT' || s.status === 'REJECTED';

const STARTABLE = ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED', 'UNDER_REVIEW', 'ACTIVE'];
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Attendance for the lecturer's own class on the phone (ATTENDANCE_FLOW §1, §6): start and open it,
 * show the code, follow the counts, approve or reject waiting check-ins, check a student in by hand,
 * close it. The roster refreshes every
 * 5 seconds here; the web dashboard's roster is live.
 */
export function LecturerAttendance({ classId, classStatus }: { classId: string; classStatus: string }) {
  const { call, me } = useAuth();
  const { palette } = useTheme();
  const canAssist = me?.activeRole === 'LECTURER' && me.permissions.includes('attendance.assisted_checkin');
  const [form, setForm] = useState<{ kind: 'reject' | 'assist'; line: RosterLine } | null>(null);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<AssistMethod | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const navigation = useNavigation<RootNavigation>();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const attendance = useQuery({
    queryKey: ['class-attendance', classId],
    queryFn: () => call<{ data: AttendanceSession | null }>(`/class-sessions/${classId}/attendance`),
    refetchInterval: 15_000,
  });
  const a = attendance.data?.data ?? null;
  const roster = useQuery({
    queryKey: ['roster', a?.id],
    enabled: Boolean(a),
    queryFn: () => call<Roster>(`/attendance-sessions/${a!.id}/roster`),
    refetchInterval: a?.status === 'OPEN' ? 5_000 : false,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['class-attendance', classId] }),
      queryClient.invalidateQueries({ queryKey: ['roster'] }),
      queryClient.invalidateQueries({ queryKey: ['class', classId] }),
    ]);

  async function act(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    setProblem(null);
    try {
      await run();
      setForm(null);
      await refresh();
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  if (attendance.isPending) return null;
  const waiting = (roster.data?.students ?? []).filter(
    (s) => s.status === 'PENDING' || s.status === 'UNDER_REVIEW',
  );
  const counts = roster.data?.counts ?? {};
  const notIn = (roster.data?.students ?? []).filter(missing);

  function openForm(kind: 'reject' | 'assist', line: RosterLine) {
    setForm({ kind, line });
    setNote('');
    setMethod(null);
    setProblem(null);
  }

  function submitForm() {
    if (!form || !a) return;
    if (note.trim().length < 5) return setProblem('Write a reason, at least 5 characters.');
    const { kind, line } = form;
    if (kind === 'reject') {
      return void act(line.studentId, () =>
        call(`/attendance-records/${line.recordId}/decide`, {
          method: 'POST',
          body: { decision: 'REJECT', note: note.trim(), version: line.version },
        }),
      );
    }
    if (!method) return setProblem('Choose why the student is checked in by hand.');
    void act(line.studentId, () =>
      call(`/attendance-sessions/${a.id}/assisted-check-ins`, {
        method: 'POST',
        body: { studentId: line.studentId, method, reason: note.trim() },
      }),
    );
  }

  const formFor = (line: RosterLine) =>
    form && form.line.studentId === line.studentId ? (
      <View style={{ gap: 8 }}>
        {form.kind === 'assist' ? (
          <ChoiceChips choices={ASSIST_CHOICES} value={method} onChange={setMethod} />
        ) : null}
        <TextField
          label={form.kind === 'reject' ? 'Why is this check-in rejected?' : 'Reason'}
          value={note}
          onChangeText={setNote}
          maxLength={500}
        />
        {/* Shown here, next to the form: the top of the card may be scrolled out of sight (phone test). */}
        {problem ? <Notice tone="error">{problem}</Notice> : null}
        <Button
          label={form.kind === 'reject' ? 'Reject check-in' : 'Check in'}
          busy={busy === line.studentId}
          onPress={submitForm}
        />
        <Button label="Cancel" variant="secondary" onPress={() => setForm(null)} />
      </View>
    ) : null;
  return (
    <Card>
      <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Attendance</Text>
      {problem && !form ? <Notice tone="error">{problem}</Notice> : null}
      {attendance.isError ? <Notice tone="error">{describeError(attendance.error)}</Notice> : null}
      {!a ? (
        STARTABLE.includes(classStatus) ? (
          <Button
            label={classStatus === 'ACTIVE' ? 'Open attendance' : 'Start class and open attendance'}
            busy={busy === 'open'}
            onPress={() =>
              void act('open', () =>
                call(`/class-sessions/${classId}/attendance/open`, {
                  method: 'POST',
                  body: { startClass: true },
                }),
              )
            }
          />
        ) : (
          <BodyText muted>Attendance was not taken for this class.</BodyText>
        )
      ) : (
        <>
          <BodyText>
            {a.status === 'OPEN'
              ? `Open until ${time(a.closesAt)} · late after ${time(a.lateAfter)}`
              : 'Attendance is closed.'}
          </BodyText>
          <BodyText muted>
            {`Present ${counts.PRESENT ?? 0} · late ${counts.LATE ?? 0} · waiting ${waiting.length} · not checked in ${(counts.notCheckedIn ?? 0) + (counts.ABSENT ?? 0)} of ${counts.enrolled ?? 0}`}
          </BodyText>
          {roster.data?.degraded ? (
            <Notice tone="info">
              The classroom beacon is not working: check-ins wait for you. Approve them below or on the
              dashboard.
            </Notice>
          ) : null}
          {a.status === 'OPEN' ? (
            <Button
              label="Show the code"
              onPress={() => navigation.navigate('AttendanceCode', { attendanceSessionId: a.id })}
            />
          ) : null}
          {waiting.map((s) => (
            <View key={s.studentId} style={{ gap: 4 }}>
              <BodyText>{`${s.fullName} (${s.studentNumber}) · ${RECORD_LABELS[s.status!] ?? s.status}`}</BodyText>
              {form?.line.studentId === s.studentId ? (
                formFor(s)
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label="Approve"
                      variant="secondary"
                      busy={busy === s.studentId}
                      onPress={() =>
                        void act(s.studentId, () =>
                          call(`/attendance-records/${s.recordId}/decide`, {
                            method: 'POST',
                            body: { decision: 'APPROVE', version: s.version },
                          }),
                        )
                      }
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button label="Reject" variant="secondary" onPress={() => openForm('reject', s)} />
                  </View>
                </View>
              )}
            </View>
          ))}
          {canAssist && RUNNING.includes(classStatus) && notIn.length > 0 ? (
            <Button
              label={showMissing ? 'Hide students not checked in' : 'Check a student in by hand'}
              variant="secondary"
              onPress={() => setShowMissing((v) => !v)}
            />
          ) : null}
          {canAssist && RUNNING.includes(classStatus) && showMissing
            ? notIn.map((s) => (
                <View key={s.studentId} style={{ gap: 4 }}>
                  <BodyText>{`${s.fullName} (${s.studentNumber})${s.status ? ` · ${RECORD_LABELS[s.status] ?? s.status}` : ''}`}</BodyText>
                  {form?.line.studentId === s.studentId ? (
                    formFor(s)
                  ) : (
                    <Button
                      label="Check in by hand"
                      variant="secondary"
                      onPress={() => openForm('assist', s)}
                    />
                  )}
                </View>
              ))
            : null}
          {a.status === 'OPEN' ? (
            <Button
              label="Close attendance"
              variant="secondary"
              busy={busy === 'close'}
              onPress={() =>
                void act('close', () =>
                  call(`/attendance-sessions/${a.id}/close`, { method: 'POST', body: {} }),
                )
              }
            />
          ) : null}
        </>
      )}
    </Card>
  );
}
