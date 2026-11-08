import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  type LoginRequest,
  MFA_REQUIRED_ROLES,
  type MfaVerifyRequest,
  STUDENT_NUMBER_PATTERN,
} from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import { AppConfig } from '../../config/app-config.js';
import type { ClientType, RoleKey, User } from '../../generated/prisma/client.js';
import { MailService } from '../../infrastructure/mail/mail.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import { AccountTokensService } from './account-tokens.service.js';
import {
  accountInactive,
  invalidCredentials,
  invalidLinkToken,
  invalidMfa,
  mfaChallengeExpired,
  noRole,
  signInAgain,
} from './auth-errors.js';
import { isLocked, lockUntilAfterFailure } from './lockout.js';
import { MAX_MFA_ATTEMPTS, MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { type AccessClaims, MFA_TOKEN_TTL_SECONDS, TokenService } from './token.service.js';

/** Roles a person can act as, least privileged first. COURSE_REP comes from an assignment, not a sign-in role. */
const SIGN_IN_ROLES: readonly RoleKey[] = [
  'STUDENT',
  'LECTURER',
  'REGISTRAR',
  'UNIVERSITY_ADMIN',
  'SUPER_ADMIN',
];

export interface SessionTokens {
  client: ClientType;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  sessionExpiresAt: Date;
  user: { id: string; email: string; fullName: string };
  activeRole: RoleKey;
  roles: RoleKey[];
}

export type LoginResult =
  { kind: 'session'; tokens: SessionTokens } | { kind: 'mfa'; mfaToken: string; enrollmentRequired: boolean };

export interface MeResponse {
  user: { id: string; email: string; fullName: string; mfaEnabled: boolean };
  activeRole: RoleKey;
  roles: RoleKey[];
  permissions: string[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly linkTokens: AccountTokensService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Sign-in ─────────────────────────

  async login(input: LoginRequest, context: RequestContext): Promise<LoginResult> {
    const now = new Date();
    const user = await this.findSignInUser(input);

    if (!user) {
      await this.passwords.verify(null, input.password);
      await this.audit.record({
        action: 'auth.login.failed',
        entityType: 'user',
        after: { reason: 'UNKNOWN_EMAIL' },
        context,
      });
      throw invalidCredentials();
    }
    if (isLocked(user.lockedUntil, now)) {
      await this.passwords.verify(null, input.password);
      await this.audit.record({
        action: 'auth.login.blocked_locked',
        entityType: 'user',
        entityId: user.id,
        context,
      });
      throw invalidCredentials();
    }

    if (!(await this.passwords.verify(user.passwordHash, input.password))) {
      await this.recordFailedPassword(user, now, context);
      throw invalidCredentials();
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        action: 'auth.login.refused_inactive',
        entityType: 'user',
        entityId: user.id,
        after: { status: user.status },
        context,
      });
      throw accountInactive();
    }

    const roles = await this.heldRoles(user.id);
    const role = this.chooseRole(roles, input.role);

    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }

    if (roles.some((r) => MFA_REQUIRED_ROLES.includes(r))) {
      const mfaToken = await this.tokens.signMfa({ userId: user.id, client: input.client, role });
      return { kind: 'mfa', mfaToken, enrollmentRequired: user.mfaEnabledAt === null };
    }
    return {
      kind: 'session',
      tokens: await this.issueSession(user, input.client, role, roles, 'password', context),
    };
  }

  async startMfaEnrollment(mfaToken: string): Promise<{ secret: string; otpauthUri: string }> {
    const claims = await this.tokens.verifyMfa(mfaToken);
    if (!claims || (await this.mfa.isChallengeExhausted(claims.challengeId))) throw mfaChallengeExpired();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: claims.userId } });
    if (user.mfaEnabledAt) {
      throw new ConflictException({
        code: 'MFA_ALREADY_ENABLED',
        message: 'Two-step sign-in is already set up.',
      });
    }
    return this.mfa.startEnrollment(user);
  }

  async verifyMfa(
    input: MfaVerifyRequest,
    context: RequestContext,
  ): Promise<SessionTokens & { recoveryCodes?: string[] }> {
    const claims = await this.tokens.verifyMfa(input.mfaToken);
    if (!claims || (await this.mfa.isChallengeExhausted(claims.challengeId))) throw mfaChallengeExpired();

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: claims.userId } });
    if (user.status !== 'ACTIVE') throw accountInactive();

    const enrolling = user.mfaEnabledAt === null;
    let passed = false;
    if (input.code) {
      passed = await this.mfa.verifyCode(user, input.code);
    } else if (input.recoveryCode && !enrolling) {
      passed = await this.mfa.useRecoveryCode(user.id, input.recoveryCode);
      if (passed) {
        await this.audit.record({
          action: 'auth.mfa.recovery_code_used',
          entityType: 'user',
          entityId: user.id,
          actorUserId: user.id,
          context,
        });
      }
    }
    if (!passed) {
      const attemptsLeft = await this.mfa.registerFailedAttempt(claims.challengeId);
      throw attemptsLeft ? invalidMfa() : mfaChallengeExpired();
    }

    // The challenge has done its job: it cannot be used to open a second session.
    await this.redis.client.set(
      `mfa:attempts:${claims.challengeId}`,
      MAX_MFA_ATTEMPTS,
      'EX',
      MFA_TOKEN_TTL_SECONDS,
    );

    let recoveryCodes: string[] | undefined;
    if (enrolling) {
      recoveryCodes = await this.mfa.completeEnrollment(user.id);
      await this.audit.record({
        action: 'auth.mfa.enabled',
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
        context,
      });
    }

    const roles = await this.heldRoles(user.id);
    const role = roles.includes(claims.role) ? claims.role : this.chooseRole(roles, undefined);
    const tokens = await this.issueSession(user, claims.client, role, roles, 'password+totp', context);
    return recoveryCodes ? { ...tokens, recoveryCodes } : tokens;
  }

  async refresh(refreshToken: string, client: ClientType, context: RequestContext): Promise<SessionTokens> {
    const { session, refreshToken: next } = await this.sessions.rotate(refreshToken, client, context);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    const roles = await this.heldRoles(user.id).catch(() => [] as RoleKey[]);
    const role = session.activeRoleKey;

    if (user.status !== 'ACTIVE' || !role || !roles.includes(role)) {
      await this.sessions.revoke(session.id, user.status !== 'ACTIVE' ? 'ACCOUNT_INACTIVE' : 'ROLE_REVOKED');
      throw signInAgain();
    }
    const access = await this.tokens.signAccess({ userId: user.id, sessionId: session.id, role });
    return {
      client: session.client,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next,
      sessionExpiresAt: session.expiresAt,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      activeRole: role,
      roles,
    };
  }

  async logout(auth: AccessClaims, context: RequestContext): Promise<void> {
    await this.sessions.revoke(auth.sessionId, 'LOGOUT');
    await this.audit.record({
      action: 'auth.logout',
      entityType: 'auth_session',
      entityId: auth.sessionId,
      actorUserId: auth.userId,
      actorRoleKey: auth.role,
      context,
    });
  }

  async me(auth: AccessClaims): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const roles = await this.heldRoles(user.id).catch(() => [] as RoleKey[]);
    const grants = await this.prisma.rolePermission.findMany({
      where: { role: { key: auth.role } },
      select: { permission: { select: { key: true } } },
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        mfaEnabled: user.mfaEnabledAt !== null,
      },
      activeRole: auth.role,
      roles,
      permissions: grants.map((g) => g.permission.key).sort(),
    };
  }

  /**
   * Changes which of the user's roles this session acts as, and returns a new access token for it.
   * The old access token stops working at once. Moving into a staff role needs a session whose
   * sign-in included a two-step code.
   */
  async switchRole(
    auth: AccessClaims,
    role: RoleKey,
    context: RequestContext,
  ): Promise<{ accessToken: string; accessTokenExpiresAt: Date; activeRole: RoleKey; roles: RoleKey[] }> {
    const roles = await this.heldRoles(auth.userId);
    if (!roles.includes(role)) {
      throw new ForbiddenException({ code: 'ROLE_NOT_HELD', message: 'You do not hold that role.' });
    }
    const session = await this.prisma.authSession.findUniqueOrThrow({ where: { id: auth.sessionId } });
    if (MFA_REQUIRED_ROLES.includes(role) && !session.mfaVerifiedAt) {
      throw new ForbiddenException({
        code: 'MFA_REQUIRED',
        message: 'This role needs two-step sign-in. Sign out and sign in again to continue.',
      });
    }
    const switched = await this.prisma.authSession.updateMany({
      where: { id: auth.sessionId, revokedAt: null, activeRoleKey: auth.role },
      data: { activeRoleKey: role },
    });
    if (switched.count !== 1) throw signInAgain();

    await this.audit.record({
      action: 'auth.role.switched',
      entityType: 'auth_session',
      entityId: auth.sessionId,
      actorUserId: auth.userId,
      actorRoleKey: role,
      before: { role: auth.role },
      after: { role },
      context,
    });
    const access = await this.tokens.signAccess({ userId: auth.userId, sessionId: auth.sessionId, role });
    return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, activeRole: role, roles };
  }

  // ───────────────────────── Activation and passwords ─────────────────────────

  /** Emails an activation link to a newly created account. Used by account creation (Phase 1 step 6). */
  async sendActivationEmail(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== 'PENDING_ACTIVATION') {
      throw new BadRequestException({
        code: 'ALREADY_ACTIVATED',
        message: 'This account is already activated.',
      });
    }
    const token = await this.linkTokens.issue(user.id, 'ACTIVATION');
    await this.mail.send({
      to: user.email,
      subject: 'Activate your AttendSure account',
      text:
        `Hello ${user.fullName},\n\n` +
        'An AttendSure account has been created for you at Knutsford University. ' +
        'To activate it and choose your password, open this link within 72 hours:\n\n' +
        `${this.config.webAppUrl}/activate?token=${token}\n\n` +
        'If you did not expect this email, you can ignore it.',
    });
  }

  async activate(input: { token: string; password: string }, context: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const userId = await this.linkTokens.consume(input.token, 'ACTIVATION', tx);
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.status !== 'PENDING_ACTIVATION') throw invalidLinkToken();
      this.passwords.assertAcceptable(input.password, user.email);
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: await this.passwords.hash(input.password), status: 'ACTIVE' },
      });
      await this.audit.record(
        {
          action: 'auth.account.activated',
          entityType: 'user',
          entityId: userId,
          actorUserId: userId,
          context,
        },
        tx,
      );
    });
  }

  /** Always behaves the same, whether or not the email exists, so it cannot be used to find accounts. */
  async requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') return;

    const token = await this.linkTokens.issue(user.id, 'PASSWORD_RESET');
    await this.audit.record({
      action: 'auth.password.reset_requested',
      entityType: 'user',
      entityId: user.id,
      context,
    });
    // Not awaited, so the response time does not reveal that the account exists. Failures are logged by MailService.
    this.mail
      .send({
        to: user.email,
        subject: 'Reset your AttendSure password',
        text:
          `Hello ${user.fullName},\n\n` +
          'Someone asked to reset the password for your AttendSure account. ' +
          'If it was you, open this link within 30 minutes:\n\n' +
          `${this.config.webAppUrl}/reset-password?token=${token}\n\n` +
          'If it was not you, ignore this email; your password stays the same.',
      })
      .catch(() => this.logger.warn(`Password reset email for user ${user.id} was not delivered`));
  }

  async resetPassword(input: { token: string; password: string }, context: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const userId = await this.linkTokens.consume(input.token, 'PASSWORD_RESET', tx);
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.status !== 'ACTIVE') throw invalidLinkToken();
      this.passwords.assertAcceptable(input.password, user.email);
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash: await this.passwords.hash(input.password),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      const ended = await this.sessions.revokeAllForUser(userId, 'PASSWORD_RESET', tx);
      await this.audit.record(
        {
          action: 'auth.password.reset',
          entityType: 'user',
          entityId: userId,
          actorUserId: userId,
          after: { sessionsEnded: ended },
          context,
        },
        tx,
      );
    });
  }

  async changePassword(
    auth: AccessClaims,
    input: { currentPassword: string; newPassword: string },
    context: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      throw new BadRequestException({
        code: 'CURRENT_PASSWORD_INCORRECT',
        message: 'Your current password is incorrect.',
      });
    }
    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException({
        code: 'PASSWORD_UNCHANGED',
        message: 'Choose a password you are not using now.',
      });
    }
    this.passwords.assertAcceptable(input.newPassword, user.email, 'newPassword');
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      const ended = await this.sessions.revokeAllForUser(user.id, 'PASSWORD_CHANGED', tx, auth.sessionId);
      await this.audit.record(
        {
          action: 'auth.password.changed',
          entityType: 'user',
          entityId: user.id,
          actorUserId: user.id,
          actorRoleKey: auth.role,
          after: { otherSessionsEnded: ended },
          context,
        },
        tx,
      );
    });
  }

  // ───────────────────────── Helpers ─────────────────────────

  private async recordFailedPassword(user: User, now: Date, context: RequestContext): Promise<void> {
    const failures = user.failedLoginCount + 1;
    const lockedUntil = lockUntilAfterFailure(failures, now);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 }, ...(lockedUntil ? { lockedUntil } : {}) },
    });
    await this.audit.record({
      action: 'auth.login.failed',
      entityType: 'user',
      entityId: user.id,
      after: { reason: 'WRONG_PASSWORD', consecutiveFailures: failures },
      context,
    });
    if (lockedUntil) {
      await this.audit.record({
        action: 'auth.account.locked',
        entityType: 'user',
        entityId: user.id,
        after: { lockedUntil: lockedUntil.toISOString() },
        context,
      });
    }
  }

  /**
   * The account behind a sign-in: by email, or by Student ID, or by staff number. Unknown identifiers
   * resolve to null and get the same answer as a wrong password.
   */
  private async findSignInUser(input: LoginRequest): Promise<User | null> {
    const raw = (input.email ?? input.identifier ?? '').trim();
    if (raw.includes('@')) return this.prisma.user.findUnique({ where: { email: raw.toLowerCase() } });
    if (STUDENT_NUMBER_PATTERN.test(raw)) {
      const student = await this.prisma.studentProfile.findUnique({
        where: { studentNumber: raw },
        include: { user: true },
      });
      if (student) return student.user;
    }
    const lecturer = await this.prisma.lecturerProfile.findUnique({
      where: { staffNumber: raw.toUpperCase() },
      include: { user: true },
    });
    return lecturer?.user ?? null;
  }

  private async heldRoles(userId: string): Promise<RoleKey[]> {
    const grants = await this.prisma.userRole.findMany({
      where: { userId, revokedAt: null },
      select: { role: { select: { key: true } } },
    });
    const held = new Set(grants.map((g) => g.role.key));
    return SIGN_IN_ROLES.filter((r) => held.has(r));
  }

  private chooseRole(roles: RoleKey[], requested: RoleKey | undefined): RoleKey {
    if (roles.length === 0) throw noRole();
    if (requested === undefined) return roles[0]!;
    if (!roles.includes(requested)) {
      throw new ForbiddenException({ code: 'ROLE_NOT_HELD', message: 'You do not hold that role.' });
    }
    return requested;
  }

  private async issueSession(
    user: User,
    client: ClientType,
    role: RoleKey,
    roles: RoleKey[],
    method: 'password' | 'password+totp',
    context: RequestContext,
  ): Promise<SessionTokens> {
    const { session, refreshToken } = await this.prisma.$transaction(async (tx) => {
      const issued = await this.sessions.create(
        { userId: user.id, client, role, mfaVerified: method === 'password+totp', context },
        tx,
      );
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await this.audit.record(
        {
          action: 'auth.login.succeeded',
          entityType: 'auth_session',
          entityId: issued.session.id,
          actorUserId: user.id,
          actorRoleKey: role,
          after: { client, method },
          context,
        },
        tx,
      );
      return issued;
    });
    const access = await this.tokens.signAccess({ userId: user.id, sessionId: session.id, role });
    return {
      client,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      sessionExpiresAt: session.expiresAt,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      activeRole: role,
      roles,
    };
  }
}
