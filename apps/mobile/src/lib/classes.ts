import type { CLASS_STATUSES } from '@attendsure/shared';

/** The class shape from GET /me/timetable and GET /class-sessions/:id (docs/API_DOCUMENTATION.md). */
export type ClassStatus = (typeof CLASS_STATUSES)[number];

export interface ClassSession {
  id: string;
  kind: 'REGULAR' | 'MAKEUP' | 'REPLACEMENT';
  status: ClassStatus;
  scheduledStart: string;
  scheduledEnd: string;
  expectedStart: string | null;
  sections: { id: string; code: string; course: { code: string; title: string } }[];
  lecturer: { id: string; fullName: string; userId: string } | null;
  classroom: { id: string; code: string; name: string } | null;
  cancelReason: string | null;
  cancelNote: string | null;
}

export interface Notification {
  id: string;
  category: string;
  title: string;
  body: string;
  data: { path?: string; sessionId?: string } | null;
  priority: 'NORMAL' | 'HIGH' | 'CRITICAL';
  readAt: string | null;
  createdAt: string;
}

export const STATUS_LABELS: Record<ClassStatus, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  POSTPONED: 'Delayed',
  UNCONFIRMED: 'Not confirmed',
  UNDER_REVIEW: 'Under review',
  ACTIVE: 'In progress',
  INTERRUPTED: 'Interrupted',
  COMPLETED: 'Held',
  CANCELLED: 'Cancelled',
  RESCHEDULED: 'Rescheduled',
  SUSPENDED: 'On hold',
};

const TIME_ZONE = 'Africa/Accra';
const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, ...options });

export const dayOf = (iso: string) =>
  fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const timeOf = (iso: string) => fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export function classTimes(s: ClassSession) {
  const base = `${timeOf(s.scheduledStart)}–${timeOf(s.scheduledEnd)}`;
  return s.expectedStart ? `${base}, now starting ${timeOf(s.expectedStart)}` : base;
}

export const classLabel = (s: ClassSession) => s.sections.map((x) => `${x.course.code} ${x.code}`).join(', ');

/** Dates (YYYY-MM-DD) in the university's time zone. */
export function localDay(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(at);
}

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
