import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/request-context.js';
import type { AuthSession, ClientType, Prisma, RoleKey } from '../../generated/prisma/client.js';
import { hashToken, newOpaqueToken } from '../../infrastructure/crypto/tokens.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import { signInAgain } from './auth-errors.js';

/** How long a sign-in lasts before the user must enter their password again. */
export const SESSION_LIFETIME_MS: Record<ClientType, number> = {
  WEB: 12 * 60 * 60_000, // a working day on a shared or office computer
  MOBILE: 30 * 24 * 60 * 60_000, // a personal phone with secure storage
};

export interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
}

export type SessionEndReason =
  | 'LOGOUT'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED'
  | 'REFRESH_TOKEN_REUSE'
  | 'ACCOUNT_INACTIVE'
  | 'ROLE_REVOKED';

/**
 * Sign-in sessions and their refresh tokens. A refresh token works once: using it returns a new one.
 * If an old, already-used token is presented, someone has copied it, so the whole session is ended.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: { userId: string; client: ClientType; role: RoleKey; context: RequestContext },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<IssuedSession> {
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_LIFETIME_MS[input.client]);
    const session = await db.authSession.create({
      data: {
        userId: input.userId,
        client: input.client,
        activeRoleKey: input.role,
        ip: input.context.ip,
        userAgent: input.context.userAgent,
        expiresAt,
        lastUsedAt: new Date(now),
      },
    });
    const refreshToken = newOpaqueToken();
    await db.refreshToken.create({
      data: { sessionId: session.id, tokenHash: hashToken(refreshToken), expiresAt },
    });
    return { session, refreshToken };
  }

  /** Exchanges a refresh token for a new one. Throws 401 if it is unknown, expired, reused or revoked. */
  async rotate(
    refreshToken: string,
    expectedClient: ClientType,
    context: RequestContext,
  ): Promise<IssuedSession> {
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash: hashToken(refreshToken) },
        include: { session: true },
      });
      if (!stored) return { kind: 'unknown' as const };
      const { session } = stored;

      if (stored.usedAt !== null) return { kind: 'reuse' as const, session };
      if (session.revokedAt || session.expiresAt <= now || stored.expiresAt <= now) {
        return { kind: 'ended' as const };
      }
      if (session.client !== expectedClient) return { kind: 'ended' as const };

      // Claim the token. If two requests race with the same token, only one update matches.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return { kind: 'reuse' as const, session };

      const next = newOpaqueToken();
      const created = await tx.refreshToken.create({
        data: { sessionId: session.id, tokenHash: hashToken(next), expiresAt: session.expiresAt },
      });
      await tx.refreshToken.update({ where: { id: stored.id }, data: { replacedById: created.id } });
      const updated = await tx.authSession.update({ where: { id: session.id }, data: { lastUsedAt: now } });
      return { kind: 'rotated' as const, issued: { session: updated, refreshToken: next } };
    });

    if (outcome.kind === 'rotated') return outcome.issued;
    if (outcome.kind === 'reuse') {
      await this.revoke(outcome.session.id, 'REFRESH_TOKEN_REUSE');
      await this.audit.record({
        action: 'auth.refresh_token.reuse_detected',
        entityType: 'auth_session',
        entityId: outcome.session.id,
        actorUserId: outcome.session.userId,
        reason: 'An already-used refresh token was presented; the session was ended.',
        context,
      });
    }
    throw signInAgain();
  }

  async revoke(
    sessionId: string,
    reason: SessionEndReason,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  /** Ends every session of a user, optionally keeping one (the session that made the change). */
  async revokeAllForUser(
    userId: string,
    reason: SessionEndReason,
    db: Prisma.TransactionClient = this.prisma,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await db.authSession.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return result.count;
  }

  /** The session behind an access token, if it is still valid and its user is still active. */
  async findActive(sessionId: string): Promise<(AuthSession & { activeRoleKey: RoleKey }) | null> {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { status: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
    if (session.user.status !== 'ACTIVE' || !session.activeRoleKey) return null;
    const { user: _user, ...rest } = session;
    return rest as AuthSession & { activeRoleKey: RoleKey };
  }
}
