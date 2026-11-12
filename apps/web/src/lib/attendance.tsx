'use client';

import { ASSIST_METHOD_LABELS, ATTENDANCE_EVENT } from '@attendsure/shared';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './auth';

/** The attendance screens (Phase 5 step 6). Labels in plain words; numbers only from the API. */

export type RecordStatus =
  'PRESENT' | 'LATE' | 'PENDING' | 'UNDER_REVIEW' | 'REJECTED' | 'ABSENT' | 'EXCUSED' | 'VOIDED';

export interface AttendanceSessionView {
  id: string;
  classSessionId: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  lateAfter: string;
  closesAt: string;
  closedAt: string | null;
  closeReason: 'MANUAL' | 'AUTO' | 'CLASS_ENDED' | 'CLASS_VOIDED' | 'FORCED' | null;
  reopenedAt: string | null;
  qrRotationSeconds: number;
  version: number;
  counts: Partial<Record<RecordStatus, number>>;
}

export interface RosterLine {
  studentId: string;
  studentNumber: string;
  fullName: string;
  status: RecordStatus | null;
  source: 'CHECK_IN' | 'ASSISTED' | 'CLOSE' | null;
  checkedInAt: string | null;
  recordId: string | null;
  version: number | null;
  attempts: number;
  lastAttempt: {
    id: string;
    outcome: string;
    reason: string | null;
    receivedAt: string;
    evidence: { ble?: string; gps?: string; device?: string };
  } | null;
}

export interface Roster {
  seq: number;
  session: AttendanceSessionView;
  degraded: boolean;
  counts: Record<string, number>;
  students: RosterLine[];
}

type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';
export const RECORD_DISPLAY: Record<RecordStatus | 'NONE', { label: string; tone: Tone }> = {
  PRESENT: { label: 'Present', tone: 'success' },
  LATE: { label: 'Late', tone: 'warning' },
  PENDING: { label: 'Waiting for you', tone: 'info' },
  UNDER_REVIEW: { label: 'Needs review', tone: 'warning' },
  REJECTED: { label: 'Not accepted', tone: 'error' },
  ABSENT: { label: 'Absent', tone: 'error' },
  EXCUSED: { label: 'Excused', tone: 'neutral' },
  VOIDED: { label: 'Voided', tone: 'neutral' },
  NONE: { label: 'Not checked in', tone: 'neutral' },
};

export const CLOSE_REASON_LABELS: Record<NonNullable<AttendanceSessionView['closeReason']>, string> = {
  MANUAL: 'closed by the lecturer',
  AUTO: 'closed at its closing time',
  CLASS_ENDED: 'closed when the class ended',
  CLASS_VOIDED: 'the class was voided',
  FORCED: 'closed by an administrator',
};

/** Why a check-in was decided as it was, in the lecturer's words. */
export const REASON_LABELS: Record<string, string> = {
  QR_INVALID: 'Not a valid code',
  QR_EXPIRED: 'Code expired',
  SESSION_NOT_OPEN: 'Attendance closed',
  NOT_ENROLLED: 'Not enrolled',
  DEVICE_REVOKED: 'Phone revoked',
  TOO_MANY_ATTEMPTS: 'Too many tries',
  BLUETOOTH_OFF: 'Bluetooth off',
  WRONG_ROOM: 'Another room’s beacon',
  NO_CLASSROOM_SIGNAL: 'Beacon not heard',
  NOT_IN_CLASSROOM: 'Not in the classroom',
  WEAK_SIGNAL: 'Weak beacon signal',
  NEW_DEVICE: 'New phone, not approved yet',
  LOCATION_CONFLICT: 'Location conflict',
  MOCK_LOCATION: 'Location looks faked',
  INTEGRITY_FAILED: 'Phone check failed',
  SHARED_DEVICE: 'Phone shared with another student',
  DEGRADED_MODE: 'Beacon not working',
  DELAYED_UPLOAD: 'Arrived late (connection)',
};

const BLE: Record<string, string> = {
  STRONG: 'Beacon ✓',
  WEAK: 'Beacon weak',
  OTHER_ROOM: 'Other room',
  NONE: 'No beacon',
  OFF: 'Bluetooth off',
};
const GPS: Record<string, string> = {
  INSIDE: 'On site ✓',
  OUTSIDE: 'Off site',
  UNCERTAIN: 'Location unsure',
  MOCKED: 'Location faked?',
};

/** "Beacon ✓ · On site ✓ · Phone ✓" from the last attempt's evidence. */
export function evidenceSummary(line: RosterLine): string {
  const e = line.lastAttempt?.evidence;
  if (!e) return line.source === 'ASSISTED' ? 'Checked in by the lecturer' : '';
  return [
    e.ble ? (BLE[e.ble] ?? e.ble) : null,
    e.gps ? (GPS[e.gps] ?? e.gps) : null,
    e.device ? (e.device === 'TRUSTED' ? 'Phone ✓' : 'New phone') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export const ASSIST_OPTIONS = Object.entries(ASSIST_METHOD_LABELS).map(([value, label]) => ({
  value,
  label,
}));

const TIME_ZONE = 'Africa/Accra';
export const timeOf = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );

/** Re-read everything that shows attendance after a change. */
export const refreshAttendance = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['attendance'] }),
    queryClient.invalidateQueries({ queryKey: ['class-session'] }),
  ]);

/**
 * The live roster (ATTENDANCE_FLOW §6): loads it, then applies numbered events from the server. An
 * event with the next number updates one line; a gap, an unnumbered event, a session change or a
 * reconnect reloads the whole roster, so a missed event never leaves a wrong screen for long.
 */
export function useLiveRoster(attendanceSessionId: string) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const key = useMemo(() => ['attendance', 'roster', attendanceSessionId], [attendanceSessionId]);
  const roster = useQuery({
    queryKey: key,
    queryFn: () => auth.call<Roster>(`/attendance-sessions/${attendanceSessionId}/roster`),
    refetchInterval: 60_000, // a slow safety net; live events do the real work
  });
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const seq = useRef<number | null>(null);
  useEffect(() => {
    if (roster.data) {
      seq.current = Math.max(seq.current ?? 0, roster.data.seq);
      setSyncedAt(Date.now());
    }
  }, [roster.data]);

  useEffect(() => {
    const reload = () => void queryClient.invalidateQueries({ queryKey: key });
    // Same address as the dashboard: /api/v1/live goes through its own /api/v1 proxy.
    const socket = io('/attendance', {
      path: '/api/v1/live',
      addTrailingSlash: false,
      auth: (cb) => {
        void auth.liveToken().then((token) => cb({ token }));
      },
    });
    socket.on('connect', () => {
      void socket.emitWithAck('join', { attendanceSessionId }).then((ack: { ok: boolean; seq?: number }) => {
        setLive(ack.ok ? 'live' : 'offline');
        reload(); // whatever happened while we were away
      });
    });
    socket.on('disconnect', (reason) => {
      setLive('offline');
      // The server asked us to reconnect (for example after Redis came back): do so.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', () => setLive('offline'));
    socket.on(ATTENDANCE_EVENT, (event: { seq: number | null; type: string; data: unknown }) => {
      const expected = (seq.current ?? 0) + 1;
      if (event.type === 'record.updated' && event.seq === expected) {
        seq.current = event.seq;
        const line = event.data as RosterLine;
        queryClient.setQueryData<Roster>(key, (old) => (old ? applyLine(old, line) : old));
        setSyncedAt(Date.now());
      } else {
        reload();
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [attendanceSessionId, auth, key, queryClient]);

  return { roster, live, syncedAt, reload: () => queryClient.invalidateQueries({ queryKey: key }) };
}

function applyLine(old: Roster, line: RosterLine): Roster {
  const before = old.students.find((s) => s.studentId === line.studentId);
  const students = before
    ? old.students.map((s) => (s.studentId === line.studentId ? line : s))
    : [...old.students, line];
  const counts = { ...old.counts };
  const bump = (status: string | null, by: number) => {
    const k = status ?? 'notCheckedIn';
    counts[k] = Math.max(0, (counts[k] ?? 0) + by);
  };
  if (before) bump(before.status, -1);
  bump(line.status, 1);
  return { ...old, students, counts };
}

/** The attendance code as an SVG: drawn from the code's own grid, so it is always sharp. */
export function QrImage({ text, size }: { text: string; size: number }) {
  const { modules, count } = useMemo(() => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    return { modules: qr.modules, count: qr.modules.size };
  }, [text]);
  const quiet = 4; // the blank border scanners need
  const total = count + quiet * 2;
  let path = '';
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (modules.get(y, x)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg
      role="img"
      aria-label="Attendance code: scan it with the AttendSure app"
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{ background: '#fff', display: 'block' }}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
