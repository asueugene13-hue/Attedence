import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import type { RoleKey } from '../src/generated/prisma/client.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { SessionService } from '../src/modules/auth/session.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import {
  ACCESS_RULE,
  Authenticated,
  Public,
  RequirePermissions,
} from '../src/modules/authorization/access.decorators.js';
import { PermissionService } from '../src/modules/authorization/permission.service.js';
import { ScopeService } from '../src/modules/authorization/scope.service.js';
import { BootstrapRefusedError, bootstrapSuperAdmin } from '../src/modules/users/bootstrap-super-admin.js';
import { createUser, resetDatabase, resetRedis, TEST_PASSWORD } from './fixtures.js';

// Routes that exist only in this test, to exercise each kind of access rule.
@Controller('test-authz')
class ProbeController {
  @Get('public')
  @Public()
  open() {
    return { ok: true };
  }

  @Get('signed-in')
  @Authenticated()
  signedIn() {
    return { ok: true };
  }

  @Get('admins')
  @RequirePermissions('users.manage_admins')
  admins() {
    return { ok: true };
  }

  @Get('run-attendance')
  @RequirePermissions('attendance.open', 'attendance.correct')
  runAttendance() {
    return { ok: true };
  }

  @Get('suspend')
  @RequirePermissions('accounts.suspend')
  suspend() {
    return { ok: true };
  }

  @Get('forgotten')
  forgotten() {
    return { ok: true, note: 'no access rule declared' };
  }
}

@Module({ imports: [AppModule, DiscoveryModule], controllers: [ProbeController] })
class TestAppModule {}

const fakeMail = { send: async (_m: MailMessage) => undefined, onModuleDestroy: () => undefined };

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
});

/** Signs a person in directly (as if they passed every sign-in step), returning an access token. */
async function tokenFor(email: string, roles: RoleKey[], options: { mfaVerified?: boolean } = {}) {
  const user = await createUser(prisma, { email, roles });
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

describe('deny by default', () => {
  it('serves public routes without sign-in and asks for sign-in everywhere else', async () => {
    await http.get('/api/v1/test-authz/public').expect(200);
    await http.get('/api/v1/test-authz/signed-in').expect(401);
    await http.get('/api/v1/test-authz/admins').expect(401);
  });

  it('refuses a route with no declared rule, even for the Super Admin', async () => {
    const { auth } = await tokenFor('super@example.test', ['SUPER_ADMIN']);
    const res = await http.get('/api/v1/test-authz/forgotten').set(auth).expect(403);
    expect(res.body.code).toBe('ACCESS_NOT_DECLARED');
  });

  it('every real route in the app declares an access rule', () => {
    const reflector = app.get(Reflector);
    const undeclared: string[] = [];
    let inspected = 0;
    for (const wrapper of app.get(DiscoveryService).getControllers()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (!controller || controller === ProbeController) continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function' || !Reflect.getMetadata('path', handler)) continue;
        inspected += 1;
        const rule = reflector.getAllAndOverride(ACCESS_RULE, [handler, controller]);
        if (!rule) undeclared.push(`${controller.name}.${name}`);
      }
    }
    expect(inspected).toBeGreaterThanOrEqual(13); // 11 auth routes + 2 health routes today
    expect(undeclared).toEqual([]);
  });
});

describe('permission checks', () => {
  it('lets any signed-in role through an @Authenticated route', async () => {
    const { auth } = await tokenFor('student@example.test', ['STUDENT']);
    await http.get('/api/v1/test-authz/signed-in').set(auth).expect(200);
  });

  it('refuses a role without the permission, and records the refusal', async () => {
    const { auth, user } = await tokenFor('registrar@example.test', ['REGISTRAR']);
    const res = await http.get('/api/v1/test-authz/admins').set(auth).expect(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'authz.denied' } });
    expect(entry.actorUserId).toBe(user.id);
    expect(entry.after).toEqual({ missing: ['users.manage_admins'] });
  });

  it('allows the Super Admin its protected permission', async () => {
    const { auth } = await tokenFor('super@example.test', ['SUPER_ADMIN']);
    await http.get('/api/v1/test-authz/admins').set(auth).expect(200);
  });

  it('requires every listed permission', async () => {
    const lecturer = await tokenFor('lecturer@example.test', ['LECTURER']);
    await http.get('/api/v1/test-authz/run-attendance').set(lecturer.auth).expect(200);
    const student = await tokenFor('student@example.test', ['STUDENT']);
    await http.get('/api/v1/test-authz/run-attendance').set(student.auth).expect(403);
    const admin = await tokenFor('admin@example.test', ['UNIVERSITY_ADMIN']);
    await http.get('/api/v1/test-authz/run-attendance').set(admin.auth).expect(403);
  });

  it('applies a newly granted permission once the cache is invalidated', async () => {
    const { auth } = await tokenFor('admin@example.test', ['UNIVERSITY_ADMIN']);
    await http.get('/api/v1/test-authz/suspend').set(auth).expect(403);

    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { key: 'accounts.suspend' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await app.get(PermissionService).invalidate('UNIVERSITY_ADMIN');

    await http.get('/api/v1/test-authz/suspend').set(auth).expect(200);
  });

  it('refuses a staff role on a session that did not pass two-step sign-in', async () => {
    const { auth } = await tokenFor('super@example.test', ['SUPER_ADMIN'], { mfaVerified: false });
    await http.get('/api/v1/test-authz/signed-in').set(auth).expect(401);
  });
});

describe('role switching', () => {
  it('switches role, issues a new token and retires the old one', async () => {
    await createUser(prisma, { email: 'both@example.test', roles: ['STUDENT', 'LECTURER'] });
    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: 'both@example.test', password: TEST_PASSWORD, client: 'MOBILE' })
      .expect(200);
    const asStudent = { Authorization: `Bearer ${login.body.accessToken}` };
    await http.get('/api/v1/test-authz/run-attendance').set(asStudent).expect(403);

    const switched = await http
      .post('/api/v1/auth/switch-role')
      .set(asStudent)
      .send({ role: 'LECTURER' })
      .expect(200);
    expect(switched.body.activeRole).toBe('LECTURER');
    const asLecturer = { Authorization: `Bearer ${switched.body.accessToken}` };
    await http.get('/api/v1/test-authz/run-attendance').set(asLecturer).expect(200);
    await http.get('/api/v1/auth/me').set(asStudent).expect(401);

    // A refresh keeps the switched role.
    const refreshed = await http
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    expect(refreshed.body.activeRole).toBe('LECTURER');
    expect(await prisma.auditLog.count({ where: { action: 'auth.role.switched' } })).toBe(1);
  });

  it('refuses a role the user does not hold', async () => {
    const { auth } = await tokenFor('student@example.test', ['STUDENT']);
    const res = await http
      .post('/api/v1/auth/switch-role')
      .set(auth)
      .send({ role: 'SUPER_ADMIN' })
      .expect(403);
    expect(res.body.code).toBe('ROLE_NOT_HELD');
  });

  it('requires two-step sign-in before switching into a staff role granted after sign-in', async () => {
    const { auth, user } = await tokenFor('student@example.test', ['STUDENT'], { mfaVerified: false });
    const registrar = await prisma.role.findUniqueOrThrow({ where: { key: 'REGISTRAR' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: registrar.id, grantedById: user.id } });
    const res = await http.post('/api/v1/auth/switch-role').set(auth).send({ role: 'REGISTRAR' }).expect(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
  });
});

describe('scopes', () => {
  it('reports institution-wide and faculty-scoped grants', async () => {
    const granter = await createUser(prisma, { email: 'granter@example.test' });
    const admin = await createUser(prisma, { email: 'admin@example.test' });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    const facultyId = '01960000-0000-7000-8000-00000000000a';
    await prisma.userRole.create({
      data: {
        userId: admin.id,
        roleId: role.id,
        grantedById: granter.id,
        scopeType: 'FACULTY',
        scopeId: facultyId,
      },
    });
    expect(await app.get(ScopeService).scopeFor(admin.id, 'UNIVERSITY_ADMIN')).toEqual({
      institutionWide: false,
      facultyIds: [facultyId],
      departmentIds: [],
    });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id, grantedById: granter.id } });
    expect((await app.get(ScopeService).scopeFor(admin.id, 'UNIVERSITY_ADMIN')).institutionWide).toBe(true);
  });
});

describe('request limits', () => {
  it('limits sign-in attempts per account and address, then says when to retry', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const attempt = (email: string) =>
      http.post('/api/v1/auth/login').send({ email, password: 'wrong-password-x', client: 'MOBILE' });
    for (let i = 0; i < 10; i++) await attempt('student@example.test').expect(401);
    const limited = await attempt('student@example.test').expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another account from the same address is not blocked by that limit.
    await attempt('other@example.test').expect(401);
  });

  it('limits password-reset emails per address', async () => {
    const ask = () => http.post('/api/v1/auth/password/forgot').send({ email: 'someone@example.test' });
    for (let i = 0; i < 3; i++) await ask().expect(202);
    await ask().expect(429);
  });
});

describe('security headers', () => {
  it('sends strict headers on every response', async () => {
    const res = await http.get('/health/live').expect(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('first Super Admin command', () => {
  it('creates an inactive Super Admin whose activation link works, then refuses to run again', async () => {
    const result = await bootstrapSuperAdmin(prisma, {
      email: 'first.admin@example.test',
      fullName: 'First Admin',
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      include: { roles: { include: { role: true } } },
    });
    expect(user.status).toBe('PENDING_ACTIVATION');
    expect(user.passwordHash).toBeNull();
    expect(user.roles.map((r) => r.role.key)).toEqual(['SUPER_ADMIN']);
    expect(
      await prisma.auditLog.count({
        where: { action: 'bootstrap.super_admin.created', actorType: 'SYSTEM' },
      }),
    ).toBe(1);

    await http
      .post('/api/v1/auth/activate')
      .send({ token: result.activationToken, password: TEST_PASSWORD })
      .expect(204);
    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: 'first.admin@example.test', password: TEST_PASSWORD, client: 'WEB' })
      .expect(200);
    expect(login.body).toMatchObject({ mfaRequired: true, enrollmentRequired: true });

    await expect(
      bootstrapSuperAdmin(prisma, { email: 'second.admin@example.test', fullName: 'Second Admin' }),
    ).rejects.toThrow(BootstrapRefusedError);
  });
});
