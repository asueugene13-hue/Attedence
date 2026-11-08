import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type CreateStaffUser, STAFF_ADMIN_ROLES, type StaffAdminRole } from '@attendsure/shared';

/** A role grant with its scope (validated by RoleGrantSchema). */
type RoleGrant = {
  role: StaffAdminRole;
  scopeType: 'INSTITUTION' | 'FACULTY' | 'DEPARTMENT';
  scopeId?: string | undefined;
};
import type { RequestContext } from '../../common/request-context.js';
import { Prisma, type RoleKey } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { SessionService } from '../auth/session.service.js';
import type { AccessClaims } from '../auth/token.service.js';

const summarySelect = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  status: true,
  mfaEnabledAt: true,
  lastLoginAt: true,
  createdAt: true,
  roles: {
    where: { revokedAt: null },
    orderBy: { grantedAt: 'asc' },
    select: { id: true, scopeType: true, scopeId: true, grantedAt: true, role: { select: { key: true } } },
  },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof summarySelect }>;

export function toUserSummary(user: UserRow) {
  const { mfaEnabledAt, roles, ...rest } = user;
  return {
    ...rest,
    mfaEnabled: mfaEnabledAt !== null,
    roles: roles.map((g) => ({
      grantId: g.id,
      role: g.role.key,
      scopeType: g.scopeType,
      scopeId: g.scopeId,
      grantedAt: g.grantedAt,
    })),
  };
}

const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such account.' });
const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Account management for the Super Admin: staff accounts, role grants, suspension and recovery.
 * Every change is audited in the same transaction. Self-lockout is prevented: nobody can suspend
 * themselves or remove their own Super Admin role, and the last active Super Admin cannot be removed.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  async list(query: {
    q?: string;
    status?: UserRow['status'];
    role?: RoleKey;
    limit: number;
    cursor?: string;
  }) {
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query.q
          ? {
              OR: [
                { email: { contains: query.q, mode: 'insensitive' } },
                { fullName: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.role ? { roles: { some: { revokedAt: null, role: { key: query.role } } } } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: summarySelect,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toUserSummary),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: summarySelect });
    if (!user) throw notFound();
    const [grantHistory, activeSessions] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId: id },
        orderBy: { grantedAt: 'desc' },
        select: {
          id: true,
          scopeType: true,
          scopeId: true,
          grantedAt: true,
          revokedAt: true,
          role: { select: { key: true } },
          grantedBy: { select: { id: true, email: true } },
          revokedBy: { select: { id: true, email: true } },
        },
      }),
      this.prisma.authSession.count({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    return {
      ...toUserSummary(user),
      activeSessions,
      grantHistory: grantHistory.map((g) => ({
        grantId: g.id,
        role: g.role.key,
        scopeType: g.scopeType,
        scopeId: g.scopeId,
        grantedAt: g.grantedAt,
        grantedBy: g.grantedBy,
        revokedAt: g.revokedAt,
        revokedBy: g.revokedBy,
      })),
    };
  }

  async create(actor: AccessClaims, input: CreateStaffUser, context: RequestContext) {
    const roleKeys = [...new Set(input.roles.map((r) => r.role))];
    const user = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email: input.email, fullName: input.fullName, phone: input.phone ?? null },
        });
        for (const grant of input.roles) {
          await this.assertScopeExists(tx, grant);
          const role = await tx.role.findUniqueOrThrow({ where: { key: grant.role } });
          await tx.userRole.create({
            data: {
              userId: created.id,
              roleId: role.id,
              grantedById: actor.userId,
              scopeType: grant.scopeType,
              scopeId: grant.scopeId ?? null,
            },
          });
        }
        await this.audit.record(
          {
            action: 'users.created',
            entityType: 'user',
            entityId: created.id,
            actorUserId: actor.userId,
            actorRoleKey: actor.role,
            after: { email: created.email, fullName: created.fullName, roles: roleKeys },
            reason: input.reason,
            context,
          },
          tx,
        );
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictException({
            code: 'EMAIL_IN_USE',
            message: 'An account already uses that email.',
          });
        }
        throw error;
      });

    let activationEmailSent = true;
    try {
      await this.auth.sendActivationEmail(user.id);
    } catch (error) {
      activationEmailSent = false;
      this.logger.error(`Activation email for new user ${user.id} failed: ${(error as Error).message}`);
    }
    return { user: await this.get(user.id), activationEmailSent };
  }

  async resendActivation(actor: AccessClaims, id: string, context: RequestContext) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound();
    await this.auth.sendActivationEmail(id);
    await this.audit.record({
      action: 'users.activation_resent',
      entityType: 'user',
      entityId: id,
      actorUserId: actor.userId,
      actorRoleKey: actor.role,
      context,
    });
  }

  async suspend(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    if (id === actor.userId) {
      throw new BadRequestException({
        code: 'CANNOT_SUSPEND_SELF',
        message: 'You cannot suspend your own account.',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, id);
      await this.assertMayManage(tx, actor, id);
      if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
        throw new ConflictException({
          code: 'ALREADY_INACTIVE',
          message: `This account is already ${user.status.toLowerCase()}.`,
        });
      }
      await this.assertNotLastSuperAdmin(tx, id);
      await tx.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
      const ended = await this.sessions.revokeAllForUser(id, 'ACCOUNT_INACTIVE', tx);
      await this.audit.record(
        {
          action: 'users.suspended',
          entityType: 'user',
          entityId: id,
          actorUserId: actor.userId,
          actorRoleKey: actor.role,
          before: { status: user.status },
          after: { status: 'SUSPENDED', sessionsEnded: ended },
          reason,
          context,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async restore(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, id);
      await this.assertMayManage(tx, actor, id);
      if (user.status !== 'SUSPENDED') {
        throw new ConflictException({
          code: 'NOT_SUSPENDED',
          message: 'Only suspended accounts can be restored.',
        });
      }
      // An account that never chose a password goes back to waiting for activation.
      const status = user.passwordHash ? 'ACTIVE' : 'PENDING_ACTIVATION';
      await tx.user.update({ where: { id }, data: { status, failedLoginCount: 0, lockedUntil: null } });
      await this.audit.record(
        {
          action: 'users.restored',
          entityType: 'user',
          entityId: id,
          actorUserId: actor.userId,
          actorRoleKey: actor.role,
          before: { status: user.status },
          after: { status },
          reason,
          context,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** For a lost or replaced authenticator: the person sets up two-step sign-in again at next sign-in. */
  async resetMfa(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    if (id === actor.userId) {
      throw new BadRequestException({
        code: 'CANNOT_RESET_OWN_MFA',
        message: 'Ask another Super Admin to reset your two-step sign-in, or use a recovery code.',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, id);
      await tx.user.update({
        where: { id },
        data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastTimeStep: null },
      });
      const codes = await tx.mfaRecoveryCode.deleteMany({ where: { userId: id } });
      const ended = await this.sessions.revokeAllForUser(id, 'PASSWORD_RESET', tx);
      await this.audit.record(
        {
          action: 'users.mfa_reset',
          entityType: 'user',
          entityId: id,
          actorUserId: actor.userId,
          actorRoleKey: actor.role,
          before: { mfaEnabled: user.mfaEnabledAt !== null },
          after: { mfaEnabled: false, recoveryCodesDeleted: codes.count, sessionsEnded: ended },
          reason,
          context,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async grantRole(
    actor: AccessClaims,
    id: string,
    grant: RoleGrant,
    reason: string,
    context: RequestContext,
  ) {
    const role = grant.role;
    await this.prisma
      .$transaction(async (tx) => {
        const user = await this.lockedUser(tx, id);
        if (user.status === 'DEACTIVATED') {
          throw new ConflictException({
            code: 'ACCOUNT_DEACTIVATED',
            message: 'Deactivated accounts cannot receive roles.',
          });
        }
        await this.assertScopeExists(tx, grant);
        const roleRow = await tx.role.findUniqueOrThrow({ where: { key: role } });
        const created = await tx.userRole.create({
          data: {
            userId: id,
            roleId: roleRow.id,
            grantedById: actor.userId,
            scopeType: grant.scopeType,
            scopeId: grant.scopeId ?? null,
          },
        });
        await this.audit.record(
          {
            action: 'users.role_granted',
            entityType: 'user',
            entityId: id,
            actorUserId: actor.userId,
            actorRoleKey: actor.role,
            after: { grantId: created.id, role, scopeType: created.scopeType, scopeId: created.scopeId },
            reason,
            context,
          },
          tx,
        );
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictException({
            code: 'ROLE_ALREADY_GRANTED',
            message: 'This person already holds that role.',
          });
        }
        throw error;
      });
    return this.get(id);
  }

  async revokeRole(
    actor: AccessClaims,
    id: string,
    grantId: string,
    reason: string,
    context: RequestContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockedUser(tx, id);
      const grant = await tx.userRole.findFirst({
        where: { id: grantId, userId: id, revokedAt: null },
        include: { role: true },
      });
      if (!grant) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such active role grant.' });

      if (grant.role.key === 'SUPER_ADMIN') {
        if (id === actor.userId) {
          throw new BadRequestException({
            code: 'CANNOT_REVOKE_OWN_SUPER_ADMIN',
            message: 'Another Super Admin must remove your Super Admin role.',
          });
        }
        await this.assertNotLastSuperAdmin(tx, id);
      }

      await tx.userRole.update({
        where: { id: grantId },
        data: { revokedAt: new Date(), revokedById: actor.userId },
      });
      // Sessions acting in this role end now, unless another grant of the same role remains.
      const remaining = await tx.userRole.count({
        where: { userId: id, roleId: grant.roleId, revokedAt: null },
      });
      const ended =
        remaining > 0
          ? 0
          : (
              await tx.authSession.updateMany({
                where: { userId: id, activeRoleKey: grant.role.key, revokedAt: null },
                data: { revokedAt: new Date(), revokeReason: 'ROLE_REVOKED' },
              })
            ).count;
      await this.audit.record(
        {
          action: 'users.role_revoked',
          entityType: 'user',
          entityId: id,
          actorUserId: actor.userId,
          actorRoleKey: actor.role,
          before: { grantId, role: grant.role.key, scopeType: grant.scopeType, scopeId: grant.scopeId },
          after: { sessionsEnded: ended },
          reason,
          context,
        },
        tx,
      );
    });
    return this.get(id);
  }

  // ───────────────────────── Safeguards ─────────────────────────

  /** A faculty or department scope must name a real, active faculty or department. */
  private async assertScopeExists(tx: Prisma.TransactionClient, grant: RoleGrant) {
    if (grant.scopeType === 'INSTITUTION') return;
    const target =
      grant.scopeType === 'FACULTY'
        ? await tx.faculty.findUnique({ where: { id: grant.scopeId! } })
        : await tx.department.findUnique({ where: { id: grant.scopeId! } });
    if (!target?.isActive) {
      throw new BadRequestException({
        code: 'INVALID_SCOPE',
        message: `No such active ${grant.scopeType === 'FACULTY' ? 'faculty' : 'department'}.`,
      });
    }
  }

  /** Reads the user and locks the row, so two administrators acting at once cannot both pass the checks. */
  private async lockedUser(tx: Prisma.TransactionClient, id: string) {
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    return tx.user.findUniqueOrThrow({ where: { id } });
  }

  /** Only a Super Admin may suspend or restore an account that holds a staff administration role. */
  private async assertMayManage(tx: Prisma.TransactionClient, actor: AccessClaims, targetId: string) {
    if (actor.role === 'SUPER_ADMIN') return;
    const protectedGrant = await tx.userRole.count({
      where: { userId: targetId, revokedAt: null, role: { key: { in: [...STAFF_ADMIN_ROLES] } } },
    });
    if (protectedGrant > 0) {
      throw new ForbiddenException({
        code: 'TARGET_PROTECTED',
        message: 'Only a Super Admin can change administrator and registrar accounts.',
      });
    }
  }

  /** Refuses a change that would leave no active Super Admin who can sign in. */
  private async assertNotLastSuperAdmin(tx: Prisma.TransactionClient, targetId: string) {
    // Lock every active Super Admin grant so two concurrent removals cannot both see "one other left".
    await tx.$queryRaw`
      SELECT ur.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE r.key = 'SUPER_ADMIN' AND ur.revoked_at IS NULL FOR UPDATE OF ur`;
    const targetIsSuperAdmin = await tx.userRole.count({
      where: { userId: targetId, revokedAt: null, role: { key: 'SUPER_ADMIN' } },
    });
    if (targetIsSuperAdmin === 0) return;
    const others = await tx.userRole.count({
      where: {
        userId: { not: targetId },
        revokedAt: null,
        role: { key: 'SUPER_ADMIN' },
        user: { status: 'ACTIVE' },
      },
    });
    if (others === 0) {
      throw new ConflictException({
        code: 'LAST_SUPER_ADMIN',
        message: 'This is the only active Super Admin. Create and activate another Super Admin first.',
      });
    }
  }
}
