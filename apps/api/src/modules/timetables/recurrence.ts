/**
 * Which dates a timetable entry meets on. Pure functions over date-only strings (YYYY-MM-DD), so every
 * recurrence rule can be tested with fixed examples. Session generation (Phase 3 step 3) uses the same
 * function, so the conflict check and the real class meetings can never disagree.
 *
 * Teaching weeks run Monday to Sunday. Week 1 is the week containing the semester's first day.
 */

export type Recurrence = 'WEEKLY' | 'EVERY_OTHER_WEEK' | 'SELECTED_WEEKS' | 'ONCE';

export interface RecurrenceRule {
  recurrence: Recurrence;
  /** 1 = Monday … 7 = Sunday. */
  dayOfWeek: number;
  effectiveFrom: string;
  effectiveTo: string;
  selectedWeeks: number[];
}

const DAY_MS = 86_400_000;
const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date) => date.toISOString().slice(0, 10);

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const weekdayOf = (day: string) => ((toDate(day).getUTCDay() + 6) % 7) + 1;

const mondayOf = (day: string) => toDate(day).getTime() - (weekdayOf(day) - 1) * DAY_MS;

/** The teaching-week number of `day`, counting the semester's first week as 1. */
export const teachingWeek = (day: string, semesterStart: string) =>
  Math.floor((mondayOf(day) - mondayOf(semesterStart)) / (7 * DAY_MS)) + 1;

export const weeksInSemester = (semesterStart: string, semesterEnd: string) =>
  teachingWeek(semesterEnd, semesterStart);

/**
 * Every date the rule meets on, before holidays and exceptions are removed.
 * EVERY_OTHER_WEEK counts from the first meeting (the first matching weekday on or after
 * `effectiveFrom`), so the first class is never skipped.
 */
export function ruleDates(rule: RecurrenceRule, semesterStart: string): string[] {
  if (rule.recurrence === 'ONCE') return [rule.effectiveFrom];
  const dates: string[] = [];
  const end = toDate(rule.effectiveTo).getTime();
  const offset = (rule.dayOfWeek - weekdayOf(rule.effectiveFrom) + 7) % 7;
  const first = toDate(rule.effectiveFrom).getTime() + offset * DAY_MS;
  const firstWeek = teachingWeek(toDay(new Date(first)), semesterStart);
  for (let t = first; t <= end; t += 7 * DAY_MS) {
    const day = toDay(new Date(t));
    const week = teachingWeek(day, semesterStart);
    if (rule.recurrence === 'EVERY_OTHER_WEEK' && (week - firstWeek) % 2 !== 0) continue;
    if (rule.recurrence === 'SELECTED_WEEKS' && !rule.selectedWeeks.includes(week)) continue;
    dates.push(day);
  }
  return dates;
}

/** The dates the entry really meets on, and the dates removed by holidays or the entry's own exceptions. */
export function meetingDates(
  rule: RecurrenceRule,
  semesterStart: string,
  noClassDays: Map<string, string>,
  entryExceptions: Map<string, string>,
): { dates: string[]; skipped: { date: string; why: string }[] } {
  const dates: string[] = [];
  const skipped: { date: string; why: string }[] = [];
  for (const day of ruleDates(rule, semesterStart)) {
    const why = entryExceptions.get(day) ?? noClassDays.get(day);
    if (why) skipped.push({ date: day, why });
    else dates.push(day);
  }
  return { dates, skipped };
}
