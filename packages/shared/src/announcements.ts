import { z } from 'zod';
import { IdSchema } from './admin.js';

/**
 * Announcements (Phase 6 step 4). Official announcements come from lecturers (to the sections they
 * teach) and administrators (to sections, a department, a faculty or the whole university, within
 * their scope). Course reps post updates to their own section only, labelled "Course rep" and limited
 * per section per day (setting `announcements.repDailyLimit`, default 3; decided 2026-11-14). Text
 * only: shown as plain text, never as HTML (SECURITY.md).
 */

export const ANNOUNCEMENT_KINDS = ['OFFICIAL', 'COURSE_REP'] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];
export const ANNOUNCEMENT_SCOPES = ['SECTION', 'DEPARTMENT', 'FACULTY', 'INSTITUTION'] as const;
export type AnnouncementScope = (typeof ANNOUNCEMENT_SCOPES)[number];

export const ANNOUNCEMENT_LIMITS = { titleMax: 150, bodyMax: 2000 } as const;

const Title = z.string().trim().min(3, 'The title is too short').max(ANNOUNCEMENT_LIMITS.titleMax);
const Body = z.string().trim().min(1, 'Write the message').max(ANNOUNCEMENT_LIMITS.bodyMax);

export const SendAnnouncementSchema = z
  .strictObject({
    scope: z.enum(ANNOUNCEMENT_SCOPES),
    /** For SECTION: one or more sections. */
    sectionIds: z.array(IdSchema).min(1).max(20).optional(),
    /** For DEPARTMENT or FACULTY. */
    departmentId: IdSchema.optional(),
    facultyId: IdSchema.optional(),
    title: Title,
    body: Body,
    /** Also email it to recipients who get announcement emails. */
    email: z.boolean().default(false),
  })
  .refine((v) => (v.scope === 'SECTION') === (v.sectionIds !== undefined), {
    message: 'Choose the sections (and only for a section announcement)',
    path: ['sectionIds'],
  })
  .refine((v) => (v.scope === 'DEPARTMENT') === (v.departmentId !== undefined), {
    message: 'Choose the department (and only for a department announcement)',
    path: ['departmentId'],
  })
  .refine((v) => (v.scope === 'FACULTY') === (v.facultyId !== undefined), {
    message: 'Choose the faculty (and only for a faculty announcement)',
    path: ['facultyId'],
  });

export const AnnouncementFeedQuerySchema = z.strictObject({
  kind: z.enum(ANNOUNCEMENT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: IdSchema.optional(),
});

export const AnnouncementListQuerySchema = z.strictObject({
  /** MINE (default): sent by the caller. REPORTED: reported ones the caller may moderate. */
  view: z.enum(['MINE', 'REPORTED']).default('MINE'),
});

export const ReportAnnouncementSchema = z.strictObject({
  reason: z.string().trim().min(5, 'Say briefly what is wrong').max(500),
});
export const HideAnnouncementSchema = z.strictObject({
  reason: z.string().trim().min(5, 'Say briefly why it is hidden').max(500),
});
