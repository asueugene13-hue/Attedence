import { Injectable } from '@nestjs/common';
import type { Prisma, TokenPurpose } from '../../generated/prisma/client.js';
import { hashToken, newOpaqueToken } from '../../infrastructure/crypto/tokens.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { invalidLinkToken } from './auth-errors.js';

export const LINK_LIFETIME_MS: Record<TokenPurpose, number> = {
  ACTIVATION: 72 * 60 * 60_000,
  PASSWORD_RESET: 30 * 60_000,
  EMAIL_CHANGE: 24 * 60 * 60_000,
};

/** Single-use links sent by email (activation, password reset). Only the token's hash is stored. */
@Injectable()
export class AccountTokensService {
  constructor(private readonly prisma: PrismaService) {}

  /** Issues a new link token. Any earlier unused link of the same kind for this user stops working. */
  async issue(
    userId: string,
    purpose: TokenPurpose,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    const now = new Date();
    await db.userToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: now } });
    const token = newOpaqueToken();
    await db.userToken.create({
      data: {
        userId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + LINK_LIFETIME_MS[purpose]),
      },
    });
    return token;
  }

  /** Marks the token used and returns its user, or throws 400 if it is unknown, used or expired. */
  async consume(token: string, purpose: TokenPurpose, db: Prisma.TransactionClient): Promise<string> {
    const now = new Date();
    const stored = await db.userToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored || stored.purpose !== purpose || stored.usedAt || stored.expiresAt <= now)
      throw invalidLinkToken();
    const claimed = await db.userToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw invalidLinkToken();
    return stored.userId;
  }
}
