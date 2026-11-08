import { z } from 'zod';
import { ROLE_KEYS } from './roles.js';

/**
 * Request shapes for sign-in endpoints. The API validates with these, and the web and mobile apps use
 * the same schemas for their forms. Unknown fields are rejected (strict objects).
 */

export const PASSWORD_MIN_LENGTH = 10;
/** Upper limit stops someone submitting a megabyte "password" to slow the hashing down. */
export const PASSWORD_MAX_LENGTH = 128;

export const ClientTypeSchema = z.enum(['WEB', 'MOBILE']);
export type ClientType = z.infer<typeof ClientTypeSchema>;

const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());

/** A new password. The server also rejects common passwords and passwords containing the email name. */
export const NewPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`);

/** A password being checked. Not policy-checked (old passwords may predate the policy), only bounded. */
const existingPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const opaqueToken = z.string().min(20).max(200);
/** Two-step sign-in challenge (a signed JWT, longer than a link token). */
const mfaToken = z.string().min(20).max(2000);

/**
 * Sign in with an email address, or (since Phase 2) with a Student ID or staff number in `identifier`.
 * `identifier` may also hold an email. Exactly one of the two fields is sent.
 */
export const LoginRequestSchema = z
  .strictObject({
    email: email.optional(),
    identifier: z.string().trim().min(1).max(254).optional(),
    password: existingPassword,
    client: ClientTypeSchema,
    /** Optional: which of the user's roles to act as. Defaults to the least-privileged one held. */
    role: z.enum(ROLE_KEYS).optional(),
  })
  .refine((v) => (v.email === undefined) !== (v.identifier === undefined), {
    message: 'send either email or identifier',
    path: ['identifier'],
  });
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const MfaEnrollRequestSchema = z.strictObject({ mfaToken });

export const MfaVerifyRequestSchema = z
  .strictObject({
    mfaToken,
    code: z
      .string()
      .regex(/^\d{6}$/, 'must be the 6-digit code from your authenticator app')
      .optional(),
    recoveryCode: z
      .string()
      .regex(/^[A-Z2-7]{5}-?[A-Z2-7]{5}$/i, 'must look like ABCDE-FGHIJ')
      .optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), {
    message: 'provide either code or recoveryCode',
  });
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

/** Mobile apps send the refresh token in the body; the web dashboard uses an httpOnly cookie instead. */
export const RefreshRequestSchema = z.strictObject({ refreshToken: opaqueToken.optional() });

export const ActivateRequestSchema = z.strictObject({ token: opaqueToken, password: NewPasswordSchema });

export const ForgotPasswordRequestSchema = z.strictObject({ email });

export const ResetPasswordRequestSchema = z.strictObject({ token: opaqueToken, password: NewPasswordSchema });

export const ChangePasswordRequestSchema = z.strictObject({
  currentPassword: existingPassword,
  newPassword: NewPasswordSchema,
});

export const SwitchRoleRequestSchema = z.strictObject({ role: z.enum(ROLE_KEYS) });
