import { describe, expect, it } from 'vitest';
import { type Evidence, evaluate, studentsForShare, type Thresholds } from './detection-engine.js';

// The D-13 defaults.
const T: Thresholds = {
  unconfirmedAfterMinutes: 15,
  reviewAfterMinutes: 30,
  reportMinStudents: 3,
  reportMinPercent: 10,
  repCorroboratingStudents: 1,
};
const base: Evidence = {
  status: 'SCHEDULED',
  minutesSinceStart: 0,
  lecturerActed: false,
  lecturerPrompted: false,
  studentReporters: 0,
  repReporters: 0,
  verbalCancellation: false,
  enrolled: 40,
};
const run = (e: Partial<Evidence>) => evaluate({ ...base, ...e }, T);

describe('detection engine (D-13)', () => {
  it('does nothing before the checkpoint without reports, or for classes it does not watch', () => {
    expect(run({ minutesSinceStart: 14 }).recommendation).toBe('NONE');
    for (const status of ['ACTIVE', 'COMPLETED', 'CANCELLED', 'RESCHEDULED', 'SUSPENDED', 'UNDER_REVIEW']) {
      expect(run({ status, minutesSinceStart: 60, studentReporters: 30 }).recommendation).toBe('NONE');
    }
  });

  it('marks a class unconfirmed at +15 without lecturer activity, but not a confirmed one', () => {
    expect(run({ minutesSinceStart: 15 }).recommendation).toBe('MARK_UNCONFIRMED');
    expect(run({ status: 'POSTPONED', minutesSinceStart: 15 }).recommendation).toBe('MARK_UNCONFIRMED');
    expect(run({ minutesSinceStart: 15, lecturerActed: true }).recommendation).toBe('NONE');
    expect(run({ status: 'CONFIRMED', minutesSinceStart: 40 }).recommendation).toBe('NONE');
  });

  it('sends an unconfirmed class to review at +30', () => {
    expect(run({ status: 'UNCONFIRMED', minutesSinceStart: 29 }).recommendation).toBe('NONE');
    expect(run({ status: 'UNCONFIRMED', minutesSinceStart: 30 })).toMatchObject({
      recommendation: 'ESCALATE_TO_REVIEW',
      priority: false,
    });
  });

  it('escalates early only when at least 3 students AND 10% of the class report', () => {
    expect(studentsForShare(40, 10)).toBe(4);
    expect(studentsForShare(8, 10)).toBe(1);
    // 40 enrolled: 3 students are not 10%; 4 are.
    expect(run({ status: 'UNCONFIRMED', minutesSinceStart: 16, studentReporters: 3 }).recommendation).toBe(
      'NONE',
    );
    expect(run({ status: 'UNCONFIRMED', minutesSinceStart: 16, studentReporters: 4 }).recommendation).toBe(
      'ESCALATE_TO_REVIEW',
    );
    // 8 enrolled: 10% is one student, but 3 are still needed.
    expect(
      run({ status: 'UNCONFIRMED', minutesSinceStart: 16, enrolled: 8, studentReporters: 2 }).recommendation,
    ).toBe('NONE');
    // The threshold also catches a confirmed class that has not started (a confirmed no-show).
    expect(run({ status: 'CONFIRMED', minutesSinceStart: 16, studentReporters: 4 }).recommendation).toBe(
      'ESCALATE_TO_REVIEW',
    );
    // Never before the +15 checkpoint, however many report.
    expect(run({ minutesSinceStart: 10, studentReporters: 30, lecturerPrompted: true }).recommendation).toBe(
      'NONE',
    );
  });

  it('course rep rule: a rep plus one other student escalates early as a priority; a rep alone never does', () => {
    const rep = { status: 'UNCONFIRMED', minutesSinceStart: 16, enrolled: 120, lecturerPrompted: true };
    expect(run({ ...rep, studentReporters: 1, repReporters: 1 }).recommendation).toBe('NONE');
    expect(run({ ...rep, studentReporters: 2, repReporters: 1 })).toMatchObject({
      recommendation: 'ESCALATE_TO_REVIEW',
      priority: true,
    });
    // The rep counts as one reporter: two reps are not "a rep plus another student" twice over.
    expect(run({ ...rep, studentReporters: 2, repReporters: 2 }).recommendation).toBe('NONE');
    // Without a rep, two students in a class of 120 are not enough.
    expect(run({ ...rep, studentReporters: 2 }).recommendation).toBe('NONE');
    // A rep alone: review still happens at +30, as a priority.
    expect(run({ ...rep, minutesSinceStart: 30, studentReporters: 1, repReporters: 1 })).toMatchObject({
      recommendation: 'ESCALATE_TO_REVIEW',
      priority: true,
    });
  });

  it('treats a verbal-cancellation report on an unconfirmed class as a priority escalation', () => {
    expect(
      run({ status: 'UNCONFIRMED', minutesSinceStart: 16, studentReporters: 1, verbalCancellation: true }),
    ).toMatchObject({ recommendation: 'ESCALATE_TO_REVIEW', priority: true });
  });

  it('nudges the lecturer once on an early report, a rep’s report as a priority', () => {
    expect(run({ minutesSinceStart: 6, studentReporters: 1 })).toMatchObject({
      recommendation: 'NOTIFY_LECTURER',
      priority: false,
    });
    expect(run({ minutesSinceStart: -5, studentReporters: 1, repReporters: 1 })).toMatchObject({
      recommendation: 'NOTIFY_LECTURER',
      priority: true,
    });
    expect(run({ minutesSinceStart: 6, studentReporters: 1, lecturerPrompted: true }).recommendation).toBe(
      'NONE',
    );
  });
});
