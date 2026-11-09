import { z } from 'zod';
import { DateOnlySchema } from './academic.js';
import { ReasonSchema } from './admin.js';
import { TimeSchema, toMinutes } from './timetables.js';

/**
 * Rescheduling a class (D-11, decided 2026-11-09): the class's lecturer asks for a new time and room;
 * an authorised administrator approves or rejects after seeing the conflict check. In exceptional
 * cases an administrator reschedules directly, with a reason. Times are Africa/Accra wall-clock times.
 */
export const RESCHEDULE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

/** Problems that stop a reschedule. */
export const RESCHEDULE_BLOCKERS = [
  'IN_THE_PAST',
  'ROOM_UNAVAILABLE',
  'ROOM_TAKEN',
  'LECTURER_BUSY',
] as const;

/** Things the approver should know, which do not stop it. */
export const RESCHEDULE_WARNINGS = ['STUDENT_CLASH', 'NO_CLASS_DAY', 'ROOM_TOO_SMALL'] as const;

const proposal = {
  date: DateOnlySchema,
  startTime: TimeSchema,
  endTime: TimeSchema,
  classroomId: z.uuid(),
};
const timeOrder = (v: { startTime: string; endTime: string }, ctx: z.RefinementCtx) => {
  if (toMinutes(v.endTime) <= toMinutes(v.startTime)) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'must be after the start time' });
  }
};

/** A proposed new time and room, for the conflict check. */
export const RescheduleProposalSchema = z.strictObject(proposal).superRefine(timeOrder);

/** A lecturer's request, or an administrator's direct reschedule: the proposal and why. */
export const RescheduleRequestSchema = z
  .strictObject({ ...proposal, reason: ReasonSchema })
  .superRefine(timeOrder);

export const ApproveRescheduleSchema = z.strictObject({ note: ReasonSchema.optional() });
export const RejectRescheduleSchema = z.strictObject({ note: ReasonSchema });

export const RescheduleListQuerySchema = z.strictObject({
  status: z.enum(RESCHEDULE_STATUSES).optional(),
});
