import type { CANCEL_REASONS, CLASS_STATUSES, ISSUE_TYPES } from '@attendsure/shared';

/** Shapes returned by the class, timetable, reschedule and review routes (docs/API_DOCUMENTATION.md). */
export type ClassStatus = (typeof CLASS_STATUSES)[number];

export interface ClassSessionView {
  id: string;
  kind: 'REGULAR' | 'MAKEUP' | 'REPLACEMENT';
  status: ClassStatus;
  scheduledStart: string;
  scheduledEnd: string;
  expectedStart: string | null;
  sections: { id: string; code: string; course: { id: string; code: string; title: string } }[];
  lecturer: { id: string; fullName: string; userId: string } | null;
  classroom: { id: string; code: string; name: string } | null;
  cancelReason: (typeof CANCEL_REASONS)[number] | null;
  cancelNote: string | null;
  timetableEntryId: string | null;
  rescheduledFromId: string | null;
  version: number;
}

export interface ClassEventView {
  id: string;
  type: string;
  fromStatus: ClassStatus | null;
  toStatus: ClassStatus | null;
  actorType: 'USER' | 'SYSTEM';
  actorUserId: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

export interface IssueReportView {
  id: string;
  type: (typeof ISSUE_TYPES)[number];
  note: string | null;
  reporterRole: 'STUDENT' | 'COURSE_REP' | 'LECTURER';
  reporterUserId: string | null;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
  createdAt: string;
}

export interface Finding {
  code: string;
  message: string;
}

export interface RescheduleRequestView {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  isDirect: boolean;
  reason: string;
  proposedStart: string;
  proposedEnd: string;
  proposedClassroom: { id: string; code: string; name: string } | null;
  classSession: ClassSessionView | null;
  replacementSession: ClassSessionView | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  check?: { blockers: Finding[]; warnings: Finding[] };
}

export interface ReviewView {
  id: string;
  classSessionId: string;
  trigger: 'SYSTEM_ESCALATION' | 'ADMIN_OPENED';
  isPriority: boolean;
  reasons: string[];
  openedAt: string;
  status: 'OPEN' | 'DECIDED';
  decision: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  reportCounts?: Record<string, number>;
  classSession: (ClassSessionView & { events?: ClassEventView[] }) | null;
  reports?: IssueReportView[];
}

type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

export const STATUS_DISPLAY: Record<ClassStatus, { label: string; tone: Tone }> = {
  SCHEDULED: { label: 'Scheduled', tone: 'neutral' },
  CONFIRMED: { label: 'Confirmed', tone: 'info' },
  POSTPONED: { label: 'Delayed', tone: 'warning' },
  UNCONFIRMED: { label: 'Not confirmed', tone: 'warning' },
  UNDER_REVIEW: { label: 'Under review', tone: 'error' },
  ACTIVE: { label: 'In progress', tone: 'success' },
  INTERRUPTED: { label: 'Interrupted', tone: 'warning' },
  COMPLETED: { label: 'Held', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
  RESCHEDULED: { label: 'Rescheduled', tone: 'neutral' },
  SUSPENDED: { label: 'On hold', tone: 'warning' },
};

export const CANCEL_REASON_LABELS: Record<(typeof CANCEL_REASONS)[number], string> = {
  LECTURER_UNAVAILABLE: 'Lecturer unavailable',
  ILLNESS: 'Illness',
  OFFICIAL_DUTY: 'Official duty',
  VENUE_UNAVAILABLE: 'Room unavailable',
  INSTITUTION_EVENT: 'University event or closure',
  PUBLIC_HOLIDAY: 'Public holiday',
  EMERGENCY: 'Emergency',
  LECTURER_ABSENT_NO_NOTICE: 'Lecturer absent without notice',
  OTHER: 'Other (explain)',
};

export const ISSUE_TYPE_LABELS: Record<(typeof ISSUE_TYPES)[number], string> = {
  LECTURER_NOT_ARRIVED: 'Lecturer has not arrived',
  VERBAL_CANCELLATION: 'Lecturer cancelled verbally',
  CLASS_DELAYED: 'Class is delayed',
  WRONG_CLASSROOM: 'Wrong classroom',
  VENUE_PROBLEM: 'Problem with the room',
  TIMETABLE_ERROR: 'Timetable error',
  TECHNICAL_PROBLEM: 'Technical problem',
  OTHER: 'Other',
};

export const REVIEW_DECISION_LABELS: Record<string, string> = {
  CLASS_HELD: 'The class was held',
  CANCELLED: 'Cancelled',
  POSTPONED: 'Postponed',
  RESCHEDULED: 'Rescheduled',
  NO_ACTION: 'No action needed',
};

export const EVENT_LABELS: Record<string, string> = {
  GENERATED: 'Scheduled',
  UPDATED: 'Details changed',
  VENUE_CHANGED: 'Room changed',
  CONFIRMED: 'Confirmed by the lecturer',
  STARTED: 'Started',
  DELAY_REPORTED: 'Delay reported',
  MARKED_UNCONFIRMED: 'Not confirmed 15 minutes after the start',
  LECTURER_PROMPTED: 'Lecturer asked what is happening',
  ISSUE_REPORTED: 'Problem reported',
  ESCALATED: 'Referred for review',
  REVIEW_DECIDED: 'Review decided',
  CANCELLED: 'Cancelled',
  RESCHEDULED: 'Rescheduled',
  SUSPENDED: 'Put on hold',
  RESUMED: 'Resumed',
  INTERRUPTED: 'Interrupted',
  ENDED: 'Ended',
  AUTO_ENDED: 'Ended automatically',
  REINSTATED: 'Back on',
  BEACON_DEGRADED: 'Classroom beacon not detected (check-ins wait for the lecturer)',
};

const TIME_ZONE = 'Africa/Accra';

/** "Tue 20 Aug, 10:00–11:30" in the university's time zone. */
export function classTime(
  session: Pick<ClassSessionView, 'scheduledStart' | 'scheduledEnd' | 'expectedStart'>,
) {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(session.scheduledStart));
  const time = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso),
    );
  const base = `${day}, ${time(session.scheduledStart)}–${time(session.scheduledEnd)}`;
  return session.expectedStart ? `${base} (now starting ${time(session.expectedStart)})` : base;
}

export const classLabel = (session: Pick<ClassSessionView, 'sections'>) =>
  session.sections.map((s) => `${s.course.code} ${s.code}`).join(', ') || 'Class';

/** Today's date (YYYY-MM-DD) in the university's time zone. */
export function todayInAccra(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
}

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface TimetableSummary {
  id: string;
  semesterId: string;
  name: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED';
  publishedAt: string | null;
  sessionsGeneratedAt: string | null;
  _count: { entries: number };
}

export const TIMETABLE_STATUS = {
  DRAFT: { label: 'Draft', tone: 'warning' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
} as const;

/** Every cached view a class change can affect. After any change to a class, refresh them all. */
const CLASS_QUERY_KEYS = [
  'class-session',
  'class-sessions',
  'my-timetable',
  'class-review',
  'class-reviews',
  'reschedule-requests',
  'reschedule-request',
  'notifications',
  'unread-count',
];

export function refreshClassData(queryClient: {
  invalidateQueries: (filters: { queryKey: string[] }) => Promise<unknown>;
}) {
  return Promise.all(CLASS_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}
