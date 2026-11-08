import type { RoleKey } from '@attendsure/shared';
import argon2 from 'argon2';
import { seedSystemRoles } from '../src/database/seed-system-roles.js';
import type { PrismaClient, UserStatus } from '../src/generated/prisma/client.js';

// Obviously fake people only (CLAUDE.md rule 2).
export const TEST_PASSWORD = 'river-mango-lantern-42';

const TABLES = [
  'calendar_exceptions',
  'semesters',
  'academic_years',
  'programmes',
  'departments',
  'faculties',
  'academic_levels',
  'audit_logs',
  'mfa_recovery_codes',
  'refresh_tokens',
  'auth_sessions',
  'user_tokens',
  'user_devices',
  'user_roles',
  'role_permissions',
  'permissions',
  'roles',
  'users',
];

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  await seedSystemRoles(prisma);
}

export async function createUser(
  prisma: PrismaClient,
  input: { email: string; roles?: RoleKey[]; status?: UserStatus; password?: string | null },
) {
  const password = input.password === undefined ? TEST_PASSWORD : input.password;
  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: 'Test Person',
      status: input.status ?? 'ACTIVE',
      passwordHash: password ? await argon2.hash(password, { type: argon2.argon2id }) : null,
    },
  });
  for (const key of input.roles ?? []) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, grantedById: user.id } });
  }
  return user;
}

/** Clears rate-limit counters, MFA attempt counters and the permission cache (test Redis database only). */
export async function resetRedis(redis: { client: { flushdb(): Promise<unknown> } }): Promise<void> {
  await redis.client.flushdb();
}

/**
 * Creates a person and a session for them directly, as if they passed every sign-in step,
 * and returns an Authorization header. Staff sessions are marked as two-step verified unless told otherwise.
 */
export async function signInAs(
  app: { get<T>(type: new (...args: never[]) => T): T },
  prisma: PrismaClient,
  email: string,
  roles: RoleKey[],
  options: { mfaVerified?: boolean; scope?: { type: 'FACULTY' | 'DEPARTMENT'; id: string } } = {},
) {
  const { SessionService } = await import('../src/modules/auth/session.service.js');
  const { TokenService } = await import('../src/modules/auth/token.service.js');
  const user = await createUser(prisma, { email, roles });
  if (options.scope) {
    await prisma.userRole.updateMany({
      where: { userId: user.id },
      data: { scopeType: options.scope.type, scopeId: options.scope.id },
    });
  }
  const { session } = await app.get(SessionService).create({
    userId: user.id,
    client: 'WEB',
    role: roles[0]!,
    mfaVerified: options.mfaVerified ?? true,
    context: { requestId: undefined, ip: undefined, userAgent: undefined },
  });
  const { token } = await app
    .get(TokenService)
    .signAccess({ userId: user.id, sessionId: session.id, role: roles[0]! });
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
}
