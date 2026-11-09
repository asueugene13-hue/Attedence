/**
 * The detection engine (CLASS_MONITORING.md §3). A pure function: it reads only what it is given and
 * changes nothing, so every rule can be tested with fixed examples. It never recommends cancelling.
 *
 * Thresholds are decision D-13 (product owner, 2026-11-09), including the course-rep rule
 * ("corroboration"): a rep counts as one reporter; a rep plus enough other students escalates early;
 * a rep alone never escalates, but nudges the lecturer and makes the review a priority.
 */
export type Recommendation = 'NONE' | 'NOTIFY_LECTURER' | 'MARK_UNCONFIRMED' | 'ESCALATE_TO_REVIEW';

export interface Evidence {
  status: string;
  /** Minutes since the expected start (after a delay) or else the scheduled start. Negative before it. */
  minutesSinceStart: number;
  /** The lecturer has asked for a reschedule or reported an issue for this class. */
  lecturerActed: boolean;
  /** The lecturer has already been nudged about this class. */
  lecturerPrompted: boolean;
  /** Distinct students (reps included) who reported an evidence-type problem. */
  studentReporters: number;
  /** Of those, how many are course reps of the class. */
  repReporters: number;
  /** A student or rep reported that the lecturer cancelled verbally. */
  verbalCancellation: boolean;
  enrolled: number;
}

export interface Thresholds {
  unconfirmedAfterMinutes: number;
  reviewAfterMinutes: number;
  reportMinStudents: number;
  reportMinPercent: number;
  repCorroboratingStudents: number;
}

export interface Verdict {
  recommendation: Recommendation;
  priority: boolean;
  reasons: string[];
}

const WATCHED = ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED'];

/** The students needed for the share rule: at least `percent` of the class, rounded up. */
export const studentsForShare = (enrolled: number, percent: number) => Math.ceil((enrolled * percent) / 100);

export function evaluate(e: Evidence, t: Thresholds): Verdict {
  const none: Verdict = { recommendation: 'NONE', priority: false, reasons: [] };
  if (!WATCHED.includes(e.status)) return none;

  const hasRep = e.repReporters > 0;
  const priority = hasRep || e.verbalCancellation;
  const reasons: string[] = [];
  const thresholdMet =
    e.studentReporters >= t.reportMinStudents &&
    e.studentReporters >= studentsForShare(e.enrolled, t.reportMinPercent);
  const repCorroborated = hasRep && e.studentReporters - e.repReporters >= t.repCorroboratingStudents;

  if (e.minutesSinceStart >= t.unconfirmedAfterMinutes) {
    if (thresholdMet) {
      reasons.push(
        `${e.studentReporters} of ${e.enrolled} enrolled students reported a problem (threshold: ${t.reportMinStudents} and ${t.reportMinPercent}%).`,
      );
    }
    if (repCorroborated) {
      reasons.push(
        `A course rep and ${e.studentReporters - e.repReporters} other student(s) reported a problem.`,
      );
    }
    if (e.verbalCancellation && e.status === 'UNCONFIRMED') {
      reasons.push('A student reported that the lecturer cancelled the class verbally.');
    }
    if (reasons.length > 0) return { recommendation: 'ESCALATE_TO_REVIEW', priority, reasons };

    if (e.status === 'UNCONFIRMED' && e.minutesSinceStart >= t.reviewAfterMinutes) {
      return {
        recommendation: 'ESCALATE_TO_REVIEW',
        priority,
        reasons: [`Still unresolved ${t.reviewAfterMinutes} minutes after the start.`],
      };
    }
    if ((e.status === 'SCHEDULED' || e.status === 'POSTPONED') && !e.lecturerActed) {
      return {
        recommendation: 'MARK_UNCONFIRMED',
        priority: false,
        reasons: [`No lecturer activity ${t.unconfirmedAfterMinutes} minutes after the start.`],
      };
    }
  }

  // Otherwise a report only nudges the lecturer, once (the unconfirmed prompt counts as a nudge).
  if (e.studentReporters > 0 && !e.lecturerPrompted && e.status !== 'UNCONFIRMED') {
    return {
      recommendation: 'NOTIFY_LECTURER',
      priority: hasRep,
      reasons: [hasRep ? 'A course rep reported a problem.' : 'A student reported a problem.'],
    };
  }
  return none;
}
