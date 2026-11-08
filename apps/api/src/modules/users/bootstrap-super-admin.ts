import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { seedSystemRoles } from '../../database/seed-system-roles.js';
import { hashToken, newOpaqueToken } from '../../infrastructure/crypto/tokens.js';
import { LINK_LIFETIME_MS } from '../auth/account-tokens.service.js';

export const BootstrapInputSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  fullName: z.string().trim().min(2).max(200),
});
export type BootstrapInput = z.infer<typeof BootstrapInputSchema>;

export class BootstrapRefusedError extends Error {}

export interface BootstrapResult {
  userId: string;
  activationToken: string;
  activationExpiresAt: Date;
}

/**
 * Creates the very first Super Admin. There are no default passwords: the account starts as
 * PENDING_ACTIVATION and the person sets a password through the activation link, then sets up
 * two-step sign-in on their first sign-in. Refuses to run once any Super Admin exists; further
 * Super Admins are created by a signed-in Super Admin (Phase 1 step 6), with an audit trail.
 */
export async function bootstrapSuperAdmin(
  prisma: PrismaClient,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  await seedSystemRoles(prisma);

  return prisma.$transaction(async (tx) => {
    const existingAdmins = await tx.userRole.count({
      where: { revokedAt: null, role: { key: 'SUPER_ADMIN' }, user: { status: { not: 'DEACTIVATED' } } },
    });
    if (existingAdmins > 0) {
      throw new BootstrapRefusedError(
        'A Super Admin already exists. Additional Super Admins must be created by a Super Admin in AttendSure.',
      );
    }
    if (await tx.user.findUnique({ where: { email: input.email } })) {
      throw new BootstrapRefusedError(`An account already uses ${input.email}.`);
    }

    const role = await tx.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
    const user = await tx.user.create({ data: { email: input.email, fullName: input.fullName } });
    // The first grant has no human granter, so it records the new user. The audit entry says it came from this command.
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id, grantedById: user.id } });

    const activationToken = newOpaqueToken();
    const activationExpiresAt = new Date(Date.now() + LINK_LIFETIME_MS.ACTIVATION);
    await tx.userToken.create({
      data: {
        userId: user.id,
        purpose: 'ACTIVATION',
        tokenHash: hashToken(activationToken),
        expiresAt: activationExpiresAt,
      },
    });
    await tx.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: 'bootstrap.super_admin.created',
        entityType: 'user',
        entityId: user.id,
        after: { email: user.email, role: 'SUPER_ADMIN' },
        reason: 'First Super Admin created with the one-time server command.',
      },
    });
    return { userId: user.id, activationToken, activationExpiresAt };
  });
}
