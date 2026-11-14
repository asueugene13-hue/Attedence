import { z } from 'zod';

/**
 * The digital student ID (Phase 6 step 5; PRESENCE_VERIFICATION §2). The card's code starts with
 * `ASID1.` and holds only a random reference and an expiry, signed with a key used for nothing else.
 * It refreshes every 30 seconds while the phone is online; it is never shown offline (decided
 * 2026-11-14), because a code that works offline could be copied. Any signed-in staff member can check
 * one; every check is logged. The check endpoint refuses attendance codes (`AS1.`), and check-in
 * refuses ID codes.
 */
export const STUDENT_ID_QR_PREFIX = 'ASID1';
export const STUDENT_ID_CODE = {
  /** The phone asks for a new code this often. */
  refreshSeconds: 30,
  /** A code is accepted for this long after it was issued (refresh plus slack for a slow scan). */
  validSeconds: 45,
} as const;

/** Roles that may check a student's ID. */
export const STUDENT_ID_CHECKER_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN', 'REGISTRAR', 'LECTURER'] as const;

export const CheckStudentIdSchema = z.strictObject({ code: z.string().trim().min(1).max(300) });
