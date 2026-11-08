import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, ROLE_KEYS } from '@attendsure/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedSystemRoles } from '../src/database/seed-system-roles.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

// Obviously fake test data only (CLAUDE.md rule 2).
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const IDENTITY_TABLES = [
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

async function resetIdentityTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${IDENTITY_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

async function createUser(email: string) {
  return prisma.user.create({ data: { email, fullName: 'Test Person' } });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await resetIdentityTables();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetIdentityTables();
});

describe('system role seed', () => {
  it('loads the six roles, the whole catalogue and the default grants', async () => {
    const summary = await seedSystemRoles(prisma);
    const expectedGrants = ROLE_KEYS.reduce((n, r) => n + DEFAULT_ROLE_PERMISSIONS[r].length, 0);

    expect(summary).toMatchObject({
      rolesCreated: 6,
      permissionsCreated: PERMISSION_KEYS.length,
      grantsAdded: expectedGrants,
      unknownPermissions: [],
    });
    expect(await prisma.role.count()).toBe(6);
    expect(await prisma.permission.count()).toBe(PERMISSION_KEYS.length);

    const lecturer = await prisma.role.findUniqueOrThrow({
      where: { key: 'LECTURER' },
      include: { permissions: { include: { permission: true } } },
    });
    expect(lecturer.permissions.map((rp) => rp.permission.key).sort()).toEqual(
      [...DEFAULT_ROLE_PERMISSIONS.LECTURER].sort(),
    );
  });

  it('is safe to run twice', async () => {
    await seedSystemRoles(prisma);
    const second = await seedSystemRoles(prisma);
    expect(second).toEqual({
      rolesCreated: 0,
      permissionsCreated: 0,
      permissionsUpdated: 0,
      grantsAdded: 0,
      unknownPermissions: [],
    });
  });

  it('keeps grants the Super Admin switched on later', async () => {
    await seedSystemRoles(prisma);
    const admin = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    const suspend = await prisma.permission.findUniqueOrThrow({ where: { key: 'accounts.suspend' } });
    await prisma.rolePermission.create({ data: { roleId: admin.id, permissionId: suspend.id } });

    await seedSystemRoles(prisma);
    expect(await prisma.rolePermission.count({ where: { roleId: admin.id, permissionId: suspend.id } })).toBe(
      1,
    );
  });

  it('reports, but does not delete, permissions missing from the catalogue', async () => {
    await prisma.permission.create({ data: { key: 'legacy.thing', description: 'Old permission' } });
    const summary = await seedSystemRoles(prisma);
    expect(summary.unknownPermissions).toEqual(['legacy.thing']);
    expect(await prisma.permission.count({ where: { key: 'legacy.thing' } })).toBe(1);
  });
});

describe('database-enforced rules', () => {
  it('refuses to give a protected permission to any role except SUPER_ADMIN', async () => {
    await seedSystemRoles(prisma);
    const registrar = await prisma.role.findUniqueOrThrow({ where: { key: 'REGISTRAR' } });
    const assign = await prisma.permission.findUniqueOrThrow({ where: { key: 'roles.assign' } });
    await expect(
      prisma.rolePermission.create({ data: { roleId: registrar.id, permissionId: assign.id } }),
    ).rejects.toThrow(/protected permission/);
  });

  it('refuses to mark a permission protected while another role holds it', async () => {
    await seedSystemRoles(prisma);
    await expect(
      prisma.permission.update({ where: { key: 'checkins.create' }, data: { isProtected: true } }),
    ).rejects.toThrow(/cannot be protected/);
  });

  it('stores emails lower-case only', async () => {
    await expect(createUser('Test.Person@Example.Test')).rejects.toThrow();
    await expect(createUser('test.person@example.test')).resolves.toBeTruthy();
  });

  it('allows one active grant per user, role and scope, and a new grant after revoking', async () => {
    await seedSystemRoles(prisma);
    const granter = await createUser('granter@example.test');
    const lecturer = await createUser('lecturer@example.test');
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'LECTURER' } });
    const grant = { userId: lecturer.id, roleId: role.id, grantedById: granter.id };

    const first = await prisma.userRole.create({ data: grant });
    await expect(prisma.userRole.create({ data: grant })).rejects.toThrow();

    await prisma.userRole.update({
      where: { id: first.id },
      data: { revokedAt: new Date(), revokedById: granter.id },
    });
    await expect(prisma.userRole.create({ data: grant })).resolves.toBeTruthy();
  });

  it('requires a scope ID exactly when a grant is scoped, and a revoker when revoked', async () => {
    await seedSystemRoles(prisma);
    const granter = await createUser('granter@example.test');
    const admin = await createUser('admin@example.test');
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    const base = { userId: admin.id, roleId: role.id, grantedById: granter.id };

    await expect(prisma.userRole.create({ data: { ...base, scopeType: 'FACULTY' } })).rejects.toThrow();
    await expect(
      prisma.userRole.create({ data: { ...base, scopeId: '01960000-0000-7000-8000-000000000001' } }),
    ).rejects.toThrow();
    await expect(prisma.userRole.create({ data: { ...base, revokedAt: new Date() } })).rejects.toThrow();
  });

  it('allows only one trusted attendance phone per user', async () => {
    const student = await createUser('student@example.test');
    const phone = (installationId: string, status: 'TRUSTED' | 'PENDING_APPROVAL') => ({
      userId: student.id,
      installationId,
      platform: 'ANDROID' as const,
      isAttendanceDevice: true,
      status,
    });

    await prisma.userDevice.create({ data: phone('install-0001', 'TRUSTED') });
    await expect(prisma.userDevice.create({ data: phone('install-0002', 'TRUSTED') })).rejects.toThrow();
    await expect(
      prisma.userDevice.create({ data: phone('install-0002', 'PENDING_APPROVAL') }),
    ).resolves.toBeTruthy();
  });

  it('keeps the audit log append-only', async () => {
    const entry = await prisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'test.event', entityType: 'test' },
    });
    await expect(
      prisma.auditLog.update({ where: { id: entry.id }, data: { reason: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('never stores the same refresh-token hash twice', async () => {
    const user = await createUser('user@example.test');
    const session = await prisma.authSession.create({
      data: { userId: user.id, client: 'WEB', expiresAt: new Date(Date.now() + 60_000) },
    });
    const token = {
      sessionId: session.id,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await prisma.refreshToken.create({ data: token });
    await expect(prisma.refreshToken.create({ data: token })).rejects.toThrow();
  });

  it('will not delete a user who appears in the audit log', async () => {
    const user = await createUser('actor@example.test');
    await prisma.auditLog.create({
      data: { actorType: 'USER', actorUserId: user.id, action: 'test.event', entityType: 'test' },
    });
    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow();
  });
});

describe('seed respects the Super Admin', () => {
  it('does not put back a default grant that was removed on purpose', async () => {
    await seedSystemRoles(prisma);
    const registrar = await prisma.role.findUniqueOrThrow({ where: { key: 'REGISTRAR' } });
    const exportPersonal = await prisma.permission.findUniqueOrThrow({
      where: { key: 'reports.export_personal' },
    });
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: registrar.id, permissionId: exportPersonal.id } },
    });

    const again = await seedSystemRoles(prisma);
    expect(again.grantsAdded).toBe(0);
    expect(
      await prisma.rolePermission.count({ where: { roleId: registrar.id, permissionId: exportPersonal.id } }),
    ).toBe(0);
  });

  it('adds default grants for a permission that is new to the catalogue', async () => {
    await seedSystemRoles(prisma);
    const before = await prisma.rolePermission.count();
    // Simulate an older database that lacks one catalogue permission.
    const key = 'class_issues.report';
    const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
    await prisma.rolePermission.deleteMany({ where: { permissionId: permission.id } });
    await prisma.permission.delete({ where: { key } });

    const summary = await seedSystemRoles(prisma);
    expect(summary.permissionsCreated).toBe(1);
    expect(await prisma.rolePermission.count()).toBe(before);
  });
});
