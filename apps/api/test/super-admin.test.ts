import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_ROLE_PERMISSIONS } from '@attendsure/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { createUser, resetDatabase, resetRedis, signInAs, TEST_PASSWORD } from './fixtures.js';

const sentMail: MailMessage[] = [];
let mailFails = false;
const fakeMail = {
  send: async (m: MailMessage) => {
    if (mailFails) throw new Error('SMTP unavailable');
    sentMail.push(m);
  },
  onModuleDestroy: () => undefined,
};

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
  mailFails = false;
  await resetDatabase(prisma);
  // Cleared after the reset, which waits for the previous test's emails to finish.
  sentMail.length = 0;
  await resetRedis(app.get(RedisService));
});

const superAdmin = (email = 'super@example.test') => signInAs(app, prisma, email, ['SUPER_ADMIN']);
const REASON = { reason: 'Requested by the registry office (test)' };

describe('creating staff accounts', () => {
  it('creates a pending account with its roles, emails an activation link and audits it', async () => {
    const { auth, user: actor } = await superAdmin();
    const res = await http
      .post('/api/v1/users')
      .set(auth)
      .send({
        email: 'New.Registrar@Example.TEST',
        fullName: 'New Registrar',
        phone: '024 555 0123',
        roles: [{ role: 'REGISTRAR' }],
      })
      .expect(201);

    expect(res.body.activationEmailSent).toBe(true);
    expect(res.body.user).toMatchObject({
      email: 'new.registrar@example.test',
      status: 'PENDING_ACTIVATION',
      phone: '0245550123',
      mfaEnabled: false,
    });
    expect(res.body.user.roles.map((r: { role: string }) => r.role)).toEqual(['REGISTRAR']);
    expect(res.body.user.grantHistory[0].grantedBy.id).toBe(actor.id);
    expect(sentMail.at(-1)?.to).toBe('new.registrar@example.test');
    expect(await prisma.auditLog.count({ where: { action: 'users.created', actorUserId: actor.id } })).toBe(
      1,
    );
  });

  it('refuses a duplicate email and a role this screen cannot grant', async () => {
    const { auth } = await superAdmin();
    await createUser(prisma, { email: 'taken@example.test' });
    const dup = await http
      .post('/api/v1/users')
      .set(auth)
      .send({ email: 'taken@example.test', fullName: 'Someone', roles: [{ role: 'REGISTRAR' }] })
      .expect(409);
    expect(dup.body.code).toBe('EMAIL_IN_USE');
    await http
      .post('/api/v1/users')
      .set(auth)
      .send({ email: 'stu@example.test', fullName: 'A Student', roles: [{ role: 'STUDENT' }] })
      .expect(400);
    await http
      .post('/api/v1/users')
      .set(auth)
      .send({
        email: 'phone@example.test',
        fullName: 'Bad Phone',
        phone: '12345',
        roles: [{ role: 'REGISTRAR' }],
      })
      .expect(400);
  });

  it('still creates the account, and says so, when the activation email cannot be sent', async () => {
    const { auth } = await superAdmin();
    mailFails = true;
    const res = await http
      .post('/api/v1/users')
      .set(auth)
      .send({ email: 'later@example.test', fullName: 'Later Person', roles: [{ role: 'UNIVERSITY_ADMIN' }] })
      .expect(201);
    expect(res.body.activationEmailSent).toBe(false);

    mailFails = false;
    await http.post(`/api/v1/users/${res.body.user.id}/activation-email`).set(auth).expect(204);
    expect(sentMail).toHaveLength(1);
  });

  it('is limited to the Super Admin', async () => {
    const { auth } = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    await http.get('/api/v1/users').set(auth).expect(403);
    await http
      .post('/api/v1/users')
      .set(auth)
      .send({ email: 'x@example.test', fullName: 'X Person', roles: [{ role: 'REGISTRAR' }] })
      .expect(403);
  });
});

describe('listing and viewing', () => {
  it('filters by text, status and role, and pages with a cursor', async () => {
    const { auth } = await superAdmin();
    for (let i = 1; i <= 3; i++)
      await createUser(prisma, { email: `reg${i}@example.test`, roles: ['REGISTRAR'] });
    await createUser(prisma, { email: 'away@example.test', roles: ['LECTURER'], status: 'SUSPENDED' });

    const regs = await http.get('/api/v1/users?role=REGISTRAR&limit=2').set(auth).expect(200);
    expect(regs.body.data).toHaveLength(2);
    expect(regs.body.nextCursor).toBeTruthy();
    const rest = await http
      .get(`/api/v1/users?role=REGISTRAR&limit=2&cursor=${regs.body.nextCursor}`)
      .set(auth)
      .expect(200);
    expect(rest.body.data).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();

    const suspended = await http.get('/api/v1/users?status=SUSPENDED').set(auth).expect(200);
    expect(suspended.body.data.map((u: { email: string }) => u.email)).toEqual(['away@example.test']);
    const search = await http.get('/api/v1/users?q=REG2').set(auth).expect(200);
    expect(search.body.data.map((u: { email: string }) => u.email)).toEqual(['reg2@example.test']);
  });

  it('returns 404 for an unknown account and 400 for a malformed id', async () => {
    const { auth } = await superAdmin();
    await http.get('/api/v1/users/01960000-0000-7000-8000-0000000000ff').set(auth).expect(404);
    await http.get('/api/v1/users/not-an-id').set(auth).expect(400);
  });

  it('never returns password hashes or two-step secrets', async () => {
    const { auth } = await superAdmin();
    const target = await createUser(prisma, { email: 'reg@example.test', roles: ['REGISTRAR'] });
    const res = await http.get(`/api/v1/users/${target.id}`).set(auth).expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('argon2');
    expect(text).not.toContain('mfaSecret');
  });
});

describe('suspending and restoring', () => {
  it("suspends with a reason, ends the person's sessions, and restores them", async () => {
    const { auth } = await superAdmin();
    const target = await signInAs(app, prisma, 'lecturer@example.test', ['LECTURER']);
    await http.get('/api/v1/auth/me').set(target.auth).expect(200);

    await http.post(`/api/v1/users/${target.user.id}/suspend`).set(auth).send({}).expect(400);
    const suspended = await http
      .post(`/api/v1/users/${target.user.id}/suspend`)
      .set(auth)
      .send(REASON)
      .expect(200);
    expect(suspended.body.status).toBe('SUSPENDED');
    await http.get('/api/v1/auth/me').set(target.auth).expect(401);
    await http
      .post('/api/v1/auth/login')
      .send({ email: 'lecturer@example.test', password: TEST_PASSWORD, client: 'MOBILE' })
      .expect(403);

    const restored = await http
      .post(`/api/v1/users/${target.user.id}/restore`)
      .set(auth)
      .send(REASON)
      .expect(200);
    expect(restored.body.status).toBe('ACTIVE');
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'users.suspended' } });
    expect(entry.reason).toBe(REASON.reason);
  });

  it('refuses to suspend yourself or the last Super Admin', async () => {
    const { auth, user } = await superAdmin();
    const self = await http.post(`/api/v1/users/${user.id}/suspend`).set(auth).send(REASON).expect(400);
    expect(self.body.code).toBe('CANNOT_SUSPEND_SELF');

    // A University Administrator allowed to suspend accounts still cannot touch staff administrators.
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { key: 'accounts.suspend' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const admin = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    const protectedTarget = await http
      .post(`/api/v1/users/${user.id}/suspend`)
      .set(admin.auth)
      .send(REASON)
      .expect(403);
    expect(protectedTarget.body.code).toBe('TARGET_PROTECTED');
    const lecturer = await createUser(prisma, { email: 'lect@example.test', roles: ['LECTURER'] });
    await http.post(`/api/v1/users/${lecturer.id}/suspend`).set(admin.auth).send(REASON).expect(200);
  });

  it('will not suspend the last active Super Admin, even when two admins act at the same moment', async () => {
    const first = await superAdmin('first@example.test');
    const second = await superAdmin('second@example.test');
    // Simulate `first` removing `second`'s role a moment earlier: committed, while second's request is in flight.
    await prisma.userRole.updateMany({
      where: { userId: second.user.id },
      data: { revokedAt: new Date(), revokedById: first.user.id },
    });
    const res = await http
      .post(`/api/v1/users/${first.user.id}/suspend`)
      .set(second.auth)
      .send(REASON)
      .expect(409);
    expect(res.body.code).toBe('LAST_SUPER_ADMIN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: first.user.id } })).status).toBe('ACTIVE');
  });
});

describe('role grants', () => {
  it('grants a role with a reason and refuses a duplicate', async () => {
    const { auth } = await superAdmin();
    const target = await createUser(prisma, { email: 'person@example.test', roles: ['LECTURER'] });
    const res = await http
      .post(`/api/v1/users/${target.id}/roles`)
      .set(auth)
      .send({ role: 'UNIVERSITY_ADMIN', ...REASON })
      .expect(200);
    expect(res.body.roles.map((r: { role: string }) => r.role).sort()).toEqual([
      'LECTURER',
      'UNIVERSITY_ADMIN',
    ]);
    const dup = await http
      .post(`/api/v1/users/${target.id}/roles`)
      .set(auth)
      .send({ role: 'UNIVERSITY_ADMIN', ...REASON })
      .expect(409);
    expect(dup.body.code).toBe('ROLE_ALREADY_GRANTED');
    await http.post(`/api/v1/users/${target.id}/roles`).set(auth).send({ role: 'REGISTRAR' }).expect(400);
  });

  it('revokes a role and ends sessions acting in it', async () => {
    const { auth } = await superAdmin();
    const target = await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR']);
    const grant = await prisma.userRole.findFirstOrThrow({ where: { userId: target.user.id } });

    const res = await http
      .post(`/api/v1/users/${target.user.id}/roles/${grant.id}/revoke`)
      .set(auth)
      .send(REASON)
      .expect(200);
    expect(res.body.roles).toEqual([]);
    expect(res.body.grantHistory[0].revokedAt).toBeTruthy();
    await http.get('/api/v1/auth/me').set(target.auth).expect(401);
  });

  it('refuses to remove your own Super Admin role', async () => {
    await superAdmin('other@example.test');
    const { auth, user } = await superAdmin();
    const grant = await prisma.userRole.findFirstOrThrow({ where: { userId: user.id } });
    const res = await http
      .post(`/api/v1/users/${user.id}/roles/${grant.id}/revoke`)
      .set(auth)
      .send(REASON)
      .expect(400);
    expect(res.body.code).toBe('CANNOT_REVOKE_OWN_SUPER_ADMIN');
  });

  it('will not remove the last Super Admin role when two admins remove each other at once', async () => {
    const first = await superAdmin('first@example.test');
    const second = await superAdmin('second@example.test');
    // `first` has just removed `second`'s role (committed); second's own request is still in flight.
    await prisma.userRole.updateMany({
      where: { userId: second.user.id },
      data: { revokedAt: new Date(), revokedById: first.user.id },
    });
    const firstGrant = await prisma.userRole.findFirstOrThrow({ where: { userId: first.user.id } });
    const res = await http
      .post(`/api/v1/users/${first.user.id}/roles/${firstGrant.id}/revoke`)
      .set(second.auth)
      .send(REASON)
      .expect(409);
    expect(res.body.code).toBe('LAST_SUPER_ADMIN');
  });
});

describe('two-step sign-in reset', () => {
  it("clears another person's authenticator and recovery codes, and ends their sessions", async () => {
    const { auth } = await superAdmin();
    const target = await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR']);
    await prisma.user.update({
      where: { id: target.user.id },
      data: { mfaEnabledAt: new Date(), mfaSecretEnc: 'v1.x.y.z' },
    });
    await prisma.mfaRecoveryCode.create({ data: { userId: target.user.id, codeHash: 'f'.repeat(64) } });

    const res = await http
      .post(`/api/v1/users/${target.user.id}/mfa/reset`)
      .set(auth)
      .send(REASON)
      .expect(200);
    expect(res.body.mfaEnabled).toBe(false);
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: target.user.id } })).toBe(0);
    await http.get('/api/v1/auth/me').set(target.auth).expect(401);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: 'registrar@example.test', password: TEST_PASSWORD, client: 'WEB' })
      .expect(200);
    expect(login.body.enrollmentRequired).toBe(true);
  });

  it('cannot be used on your own account', async () => {
    const { auth, user } = await superAdmin();
    const res = await http.post(`/api/v1/users/${user.id}/mfa/reset`).set(auth).send(REASON).expect(400);
    expect(res.body.code).toBe('CANNOT_RESET_OWN_MFA');
  });
});

describe('role permissions', () => {
  it('lists roles with what each may be given', async () => {
    const { auth } = await superAdmin();
    const res = await http.get('/api/v1/roles').set(auth).expect(200);
    const admin = res.body.find((r: { key: string }) => r.key === 'UNIVERSITY_ADMIN');
    expect(admin.editable).toBe(true);
    const suspend = admin.assignable.find((p: { key: string }) => p.key === 'accounts.suspend');
    expect(suspend).toMatchObject({ held: false, isDefault: false });
    expect(res.body.find((r: { key: string }) => r.key === 'SUPER_ADMIN').editable).toBe(false);
  });

  it('switches on a configurable permission, effective immediately, and audits the change', async () => {
    const { auth } = await superAdmin();
    const admin = await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN']);
    const lecturer = await createUser(prisma, { email: 'lect@example.test', roles: ['LECTURER'] });
    // Warm the permission cache, then change it.
    await http.post(`/api/v1/users/${lecturer.id}/suspend`).set(admin.auth).send(REASON).expect(403);

    const permissions = [...DEFAULT_ROLE_PERMISSIONS.UNIVERSITY_ADMIN, 'accounts.suspend'];
    const res = await http
      .put('/api/v1/roles/UNIVERSITY_ADMIN/permissions')
      .set(auth)
      .send({ permissions, ...REASON })
      .expect(200);
    expect(res.body.permissions).toContain('accounts.suspend');
    await http.post(`/api/v1/users/${lecturer.id}/suspend`).set(admin.auth).send(REASON).expect(200);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'roles.permissions_changed' } });
    expect(entry.after).toMatchObject({ added: ['accounts.suspend'], removed: [] });
  });

  it('refuses permissions outside the matrix, protected permissions and the Super Admin role', async () => {
    const { auth } = await superAdmin();
    const bad = await http
      .put('/api/v1/roles/REGISTRAR/permissions')
      .set(auth)
      .send({ permissions: ['attendance.open'], ...REASON })
      .expect(400);
    expect(bad.body.code).toBe('PERMISSION_NOT_ASSIGNABLE');
    await http
      .put('/api/v1/roles/UNIVERSITY_ADMIN/permissions')
      .set(auth)
      .send({ permissions: ['roles.assign'], ...REASON })
      .expect(400);
    await http
      .put('/api/v1/roles/STUDENT/permissions')
      .set(auth)
      .send({ permissions: ['attendance.correct'], ...REASON })
      .expect(400);
    const fixed = await http
      .put('/api/v1/roles/SUPER_ADMIN/permissions')
      .set(auth)
      .send({ permissions: [], ...REASON })
      .expect(400);
    expect(fixed.body.code).toBe('ROLE_NOT_EDITABLE');
  });

  it('can remove a default permission, and the next seed does not put it back', async () => {
    const { auth } = await superAdmin();
    const permissions = DEFAULT_ROLE_PERMISSIONS.REGISTRAR.filter((k) => k !== 'reports.export_personal');
    await http
      .put('/api/v1/roles/REGISTRAR/permissions')
      .set(auth)
      .send({ permissions, ...REASON })
      .expect(200);
    const { seedSystemRoles } = await import('../src/database/seed-system-roles.js');
    await seedSystemRoles(prisma);
    const res = await http.get('/api/v1/roles').set(auth).expect(200);
    expect(res.body.find((r: { key: string }) => r.key === 'REGISTRAR').permissions).not.toContain(
      'reports.export_personal',
    );
  });
});

describe('audit-log search', () => {
  it('finds entries by action prefix and actor, newest first, and audits the search', async () => {
    const { auth, user } = await superAdmin();
    const target = await createUser(prisma, { email: 'lect@example.test', roles: ['LECTURER'] });
    await http.post(`/api/v1/users/${target.id}/suspend`).set(auth).send(REASON).expect(200);
    await http.post(`/api/v1/users/${target.id}/restore`).set(auth).send(REASON).expect(200);

    const res = await http
      .get(`/api/v1/audit-logs?action=users.&actorUserId=${user.id}`)
      .set(auth)
      .expect(200);
    expect(res.body.data.map((e: { action: string }) => e.action)).toEqual([
      'users.restored',
      'users.suspended',
    ]);
    expect(res.body.data[0].actor.email).toBe('super@example.test');
    expect(await prisma.auditLog.count({ where: { action: 'audit_logs.searched' } })).toBe(1);
  });

  it('is refused for an administrator whose scope is a faculty', async () => {
    const granter = await createUser(prisma, { email: 'granter@example.test' });
    const admin = await createUser(prisma, { email: 'fac.admin@example.test' });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'UNIVERSITY_ADMIN' } });
    await prisma.userRole.create({
      data: {
        userId: admin.id,
        roleId: role.id,
        grantedById: granter.id,
        scopeType: 'FACULTY',
        scopeId: '01960000-0000-7000-8000-00000000000a',
      },
    });
    const { SessionService } = await import('../src/modules/auth/session.service.js');
    const { TokenService } = await import('../src/modules/auth/token.service.js');
    const { session } = await app.get(SessionService).create({
      userId: admin.id,
      client: 'WEB',
      role: 'UNIVERSITY_ADMIN',
      mfaVerified: true,
      context: { requestId: undefined, ip: undefined, userAgent: undefined },
    });
    const { token } = await app
      .get(TokenService)
      .signAccess({ userId: admin.id, sessionId: session.id, role: 'UNIVERSITY_ADMIN' });
    const res = await http.get('/api/v1/audit-logs').set('Authorization', `Bearer ${token}`).expect(403);
    expect(res.body.code).toBe('SCOPE_REQUIRED');
  });
});
