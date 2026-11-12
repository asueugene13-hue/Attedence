import { useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { describeError } from '../lib/api';
import { RECORD_LABELS } from '../lib/attendance';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import type { RootNavigation } from '../navigation/types';
import { BodyText, Button, Card, Notice } from './ui';

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

const STARTABLE = ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED', 'UNDER_REVIEW', 'ACTIVE'];
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Attendance for the lecturer's own class on the phone (ATTENDANCE_FLOW §1, §6): start and open it,
 * show the code, follow the counts, approve waiting check-ins, close it. The roster refreshes every
 * 5 seconds here; the web dashboard's roster is live.
 */
export function LecturerAttendance({ classId, classStatus }: { classId: string; classStatus: string }) {
  const { call } = useAuth();
  const { palette } = useTheme();
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
  return (
    <Card>
      <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>Attendance</Text>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
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
          ))}
          {waiting.length > 0 ? (
            <BodyText muted>
              To reject a check-in (a note is needed), use the dashboard’s live roster.
            </BodyText>
          ) : null}
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
