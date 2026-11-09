import { z } from 'zod';
import { DateOnlySchema, NameSchema } from './academic.js';
import { ReasonSchema } from './admin.js';

/**
 * Timetables (Phase 3, step 2). Times are wall-clock times in Africa/Accra, written HH:MM.
 * Recurrence was decided by the product owner on 2026-11-09: weekly (default), every other week,
 * selected teaching weeks, or a single date.
 */
export const RECURRENCES = ['WEEKLY', 'EVERY_OTHER_WEEK', 'SELECTED_WEEKS', 'ONCE'] as const;
export const TIMETABLE_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED'] as const;

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time written HH:MM (24-hour)');

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const toHhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export const CreateTimetableSchema = z.strictObject({
  semesterId: z.uuid(),
  name: NameSchema,
});

const entryFields = {
  sectionIds: z.array(z.uuid()).min(1, 'choose at least one section').max(10),
  lecturerId: z.uuid(),
  classroomId: z.uuid(),
  recurrence: z.enum(RECURRENCES).default('WEEKLY'),
  /** 1 = Monday … 7 = Sunday. Not used for ONCE (the date decides). */
  dayOfWeek: z.number().int().min(1).max(7).optional(),
  /** ONCE only: the single date. */
  date: DateOnlySchema.optional(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  /** Default: the semester's first and last day. */
  effectiveFrom: DateOnlySchema.optional(),
  effectiveTo: DateOnlySchema.optional(),
  /** SELECTED_WEEKS only: teaching-week numbers, week 1 = the semester's first week. */
  selectedWeeks: z.array(z.number().int().min(1).max(60)).max(60).optional(),
};

type EntryShape = {
  recurrence: (typeof RECURRENCES)[number];
  dayOfWeek?: number | undefined;
  date?: string | undefined;
  startTime: string;
  endTime: string;
  effectiveFrom?: string | undefined;
  effectiveTo?: string | undefined;
  selectedWeeks?: number[] | undefined;
};

/** Rules that need several fields together. */
function entryRules(v: EntryShape, ctx: z.RefinementCtx) {
  if (toMinutes(v.endTime) <= toMinutes(v.startTime)) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'must be after the start time' });
  }
  if (v.recurrence === 'ONCE') {
    if (!v.date)
      ctx.addIssue({ code: 'custom', path: ['date'], message: 'is required for a one-time class' });
  } else if (v.dayOfWeek === undefined) {
    ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: 'is required for a repeating class' });
  }
  if (v.recurrence === 'SELECTED_WEEKS' && !v.selectedWeeks?.length) {
    ctx.addIssue({ code: 'custom', path: ['selectedWeeks'], message: 'choose at least one week' });
  }
  if (v.recurrence !== 'SELECTED_WEEKS' && v.selectedWeeks?.length) {
    ctx.addIssue({ code: 'custom', path: ['selectedWeeks'], message: 'only applies to "selected weeks"' });
  }
  if (v.effectiveFrom && v.effectiveTo && v.effectiveTo < v.effectiveFrom) {
    ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'must not be before the start date' });
  }
}

export const TimetableEntrySchema = z.strictObject(entryFields).superRefine(entryRules);
export type TimetableEntryInput = z.output<typeof TimetableEntrySchema>;

export const EntryExceptionSchema = z.strictObject({ date: DateOnlySchema, reason: ReasonSchema });

export const TimetableQuerySchema = z.strictObject({
  semesterId: z.uuid().optional(),
  status: z.enum(TIMETABLE_STATUSES).optional(),
});

export const PublishTimetableSchema = z.strictObject({ reason: ReasonSchema.optional() });
