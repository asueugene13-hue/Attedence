import { ConflictException, Injectable } from '@nestjs/common';
import type { RoleKey } from '@attendsure/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Account operations other modules need (registering a student or a lecturer creates or extends an
 * account). Accounts and role grants are owned here; other modules call these methods instead of
 * writing users or user_roles themselves (CLAUDE.md rule 8).
 */
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds the account for this email or creates a pending one, and makes sure it holds `role`.
   * A deactivated account is refused. Runs inside the caller's transaction.
   */
  async ensureAccountWithRole(
    tx: Tx,
    input: { email: string; fullName: string; phone?: string | null },
    role: RoleKey,
    grantedById: string,
  ): Promise<{ userId: string; newAccount: boolean }> {
    const existing = await tx.user.findUnique({ where: { email: input.email } });
    if (existing?.status === 'DEACTIVATED') {
      throw new ConflictException({ code: 'ACCOUNT_DEACTIVATED', message: 'That account is deactivated.' });
    }
    const user =
      existing ??
      (await tx.user.create({
        data: { email: input.email, fullName: input.fullName, phone: input.phone ?? null },
      }));
    const roleRow = await tx.role.findUniqueOrThrow({ where: { key: role } });
    const holds = await tx.userRole.count({
      where: { userId: user.id, roleId: roleRow.id, revokedAt: null },
    });
    if (holds === 0) await tx.userRole.create({ data: { userId: user.id, roleId: roleRow.id, grantedById } });
    return { userId: user.id, newAccount: !existing };
  }

  /** Account id and status by email, for import checks. */
  async byEmails(emails: string[]) {
    const rows = await this.prisma.user.findMany({
      where: { email: { in: [...new Set(emails)] } },
      select: { id: true, email: true, status: true },
    });
    return new Map(rows.map((u) => [u.email, u]));
  }

  async find(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, phone: true, status: true },
    });
  }

  /** Name and phone live on the account; profiles (student, lecturer) change them through here. */
  async updateContact(tx: Tx, userId: string, input: { fullName?: string; phone?: string }): Promise<void> {
    if (input.fullName === undefined && input.phone === undefined) return;
    await tx.user.update({ where: { id: userId }, data: { fullName: input.fullName, phone: input.phone } });
  }
}
