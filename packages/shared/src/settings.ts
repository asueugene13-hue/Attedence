import { z } from 'zod';
import { ReasonSchema } from './admin.js';

/**
 * Institution settings (Phase 3). Each has a validated value and a default; a setting nobody has
 * changed uses its default. Changing one needs a reason and is audited. The monitoring values are
 * decision D-13 (product owner, 2026-11-09).
 */
export const SETTINGS = {
  'monitoring.unconfirmedAfterMinutes': {
    label: 'Class becomes unconfirmed after (minutes)',
    description:
      'Minutes after the (expected) start with no lecturer activity before a class becomes UNCONFIRMED.',
    schema: z.number().int().min(5).max(120),
    default: 15,
  },
  'monitoring.reviewAfterMinutes': {
    label: 'Unresolved class goes to review after (minutes)',
    description:
      'Minutes after the (expected) start before an unresolved class goes to an administrator for review.',
    schema: z.number().int().min(10).max(240),
    default: 30,
  },
  'monitoring.reportMinStudents': {
    label: 'Early review: minimum reporting students',
    description: 'At least this many different students must report a problem for an early review.',
    schema: z.number().int().min(1).max(100),
    default: 3,
  },
  'monitoring.reportMinPercent': {
    label: 'Early review: minimum share of the class (%)',
    description: 'The reporting students must also be at least this share of the enrolled class.',
    schema: z.number().min(1).max(100),
    default: 10,
  },
  'monitoring.repCorroboratingStudents': {
    label: 'Early review with a course rep: other students needed',
    description:
      'A course rep’s report plus at least this many other students reporting a problem sends an unconfirmed class to review early. A rep alone never does (D-13).',
    schema: z.number().int().min(1).max(20),
    default: 1,
  },
  // Attendance (ATTENDANCE_FLOW §1, §9). Interim defaults until Knutsford's regulations are known (D-09).
  'attendance.lateAfterMinutes': {
    label: 'Check-ins count as late after (minutes)',
    description:
      'Minutes after the later of the scheduled start and the moment attendance opened. Interim default until Knutsford’s rules are set (D-09).',
    schema: z.number().int().min(0).max(120),
    default: 15,
  },
  'attendance.closeAfterMinutes': {
    label: 'Attendance closes after (minutes)',
    description:
      'Minutes after attendance opens; the lecturer can close early or extend. Interim default until Knutsford’s rules are set (D-09).',
    schema: z.number().int().min(5).max(240),
    default: 20,
  },
  'attendance.lecturerCorrectionDays': {
    label: 'Lecturers correct records directly for (days)',
    description:
      'Days after a class during which its lecturer corrects attendance directly, with a reason. Later corrections wait for an administrator (ATTENDANCE_FLOW §7).',
    schema: z.number().int().min(1).max(90),
    default: 14,
  },
  'requests.disputeDays': {
    label: 'Students can dispute a record for (days)',
    description:
      'Days after a class during which a student can dispute an absent or rejected record (D-21). Interim default until Knutsford sets its own.',
    schema: z.number().int().min(1).max(90),
    default: 14,
  },
  'requests.excuseDays': {
    label: 'Students can ask for an excuse for (days)',
    description:
      'Days after the last class it covers during which a student can send an excuse request (D-22). Interim default until Knutsford sets its own.',
    schema: z.number().int().min(1).max(90),
    default: 14,
  },
  'attendance.lateWeight': {
    label: 'A late check-in counts as (share of attended)',
    description:
      '1 means late counts as attended; 0.5 as half. Interim default until Knutsford’s rules are set (D-09).',
    schema: z.number().min(0).max(1),
    default: 1,
  },
  'attendance.minimumPercent': {
    label: 'Minimum attendance (%)',
    description:
      'Students below this see a warning. Not set until the Registrar enters Knutsford’s real figure (D-09): until then no warning is shown.',
    schema: z.number().min(1).max(100).nullable(),
    default: null,
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;

export const SettingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);
export const UpdateSettingSchema = z.strictObject({ value: z.unknown(), reason: ReasonSchema });

export const SystemEventQuerySchema = z.strictObject({
  unacknowledged: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
