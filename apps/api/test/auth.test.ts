import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createUser, resetDatabase, resetRedis, TEST_PASSWORD } from './fixtures.js';

const sentMail: MailMessage[] = [];
const fakeMail = { send: async (m: MailMessage) => void sentMail.push(m), onModuleDestroy: () => undefined };
const WEB_ORIGIN = new URL(process.env.WEB_APP_URL ?? 'http://localhost:3001').origin;

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
  await resetDatabase(prisma);
  // Cleared after the reset, which waits for the previous test's emails to finish.
  sentMail.length = 0;
  await resetRedis(app.get(RedisService));
});

function tokenFromMail(path: string): string {
  const mail = sentMail.at(-1);
  const match = mail?.text.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  if (!match?.[1]) throw new Error(`no ${path} link in the last email`);
  return match[1];
}

function refreshCookie(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith('as_refresh='));
}

const login = (email: string, client: 'WEB' | 'MOBILE' = 'MOBILE', password = TEST_PASSWORD) =>
  http.post('/api/v1/auth/login').send({ email, password, client });

describe('activation', () => {
  it('lets a new account set its password once, then sign in', async () => {
    const user = await createUser(prisma, {
      email: 'new.student@example.test',
      roles: ['STUDENT'],
      status: 'PENDING_ACTIVATION',
      password: null,
    });
    await app.get(AuthService).sendActivationEmail(user.id);
    expect(sentMail.at(-1)?.to).toBe('new.student@example.test');
    const token = tokenFromMail('/activate');

    await http.post('/api/v1/auth/activate').send({ token, password: TEST_PASSWORD }).expect(204);
    await http.post('/api/v1/auth/activate').send({ token, password: TEST_PASSWORD }).expect(400);
    await login('new.student@example.test').expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'auth.account.activated' } })).toBe(1);
  });

  it('rejects a weak password without using up the link', async () => {
    const user = await createUser(prisma, {
      email: 'kofi@example.test',
      status: 'PENDING_ACTIVATION',
      password: null,
    });
    await app.get(AuthService).sendActivationEmail(user.id);
    const token = tokenFromMail('/activate');

    const weak = await http
      .post('/api/v1/auth/activate')
      .send({ token, password: 'Password123' })
      .expect(400);
    expect(weak.body.code).toBe('VALIDATION_FAILED');
    expect(weak.body.errors[0].field).toBe('password');
    const short = await http.post('/api/v1/auth/activate').send({ token, password: 'short' }).expect(400);
    expect(short.body.errors[0].field).toBe('password');

    await http.post('/api/v1/auth/activate').send({ token, password: TEST_PASSWORD }).expect(204);
  });

  it('rejects an expired link', async () => {
    const user = await createUser(prisma, {
      email: 'late@example.test',
      status: 'PENDING_ACTIVATION',
      password: null,
    });
    await app.get(AuthService).sendActivationEmail(user.id);
    await prisma.userToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await http
      .post('/api/v1/auth/activate')
      .send({ token: tokenFromMail('/activate'), password: TEST_PASSWORD })
      .expect(400);
    expect(res.body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });
});

describe('login', () => {
  it('gives a mobile app its refresh token in the body', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const res = await login('student@example.test').expect(200);
    expect(res.body).toMatchObject({ client: 'MOBILE', activeRole: 'STUDENT', roles: ['STUDENT'] });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(refreshCookie(res)).toBeUndefined();
  });

  it('gives the web dashboard an httpOnly, Strict cookie and no refresh token in the body', async () => {
    await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
    const res = await login('lecturer@example.test', 'WEB').expect(200);
    expect(res.body.refreshToken).toBeUndefined();
    const cookie = refreshCookie(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const wrong = await login('student@example.test', 'MOBILE', 'not-the-password-1').expect(401);
    const unknown = await login('nobody@example.test').expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.detail).toBe(wrong.body.detail);
  });

  it('treats email case-insensitively', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    await login('Student@Example.TEST').expect(200);
  });

  it('locks the account after 5 wrong passwords, even for the right password, until the lock passes', async () => {
    const user = await createUser(prisma, { email: 'target@example.test', roles: ['STUDENT'] });
    for (let i = 0; i < 5; i++)
      await login('target@example.test', 'MOBILE', `wrong-password-${i}`).expect(401);

    const locked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    await login('target@example.test').expect(401);
    expect(await prisma.auditLog.count({ where: { action: 'auth.account.locked' } })).toBe(1);

    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await login('target@example.test').expect(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  });

  it('refuses suspended accounts and accounts with no role', async () => {
    await createUser(prisma, { email: 'suspended@example.test', roles: ['STUDENT'], status: 'SUSPENDED' });
    await createUser(prisma, { email: 'norole@example.test' });
    expect((await login('suspended@example.test').expect(403)).body.code).toBe('ACCOUNT_INACTIVE');
    expect((await login('norole@example.test').expect(403)).body.code).toBe('NO_ROLE');
  });

  it('starts in the least-privileged role, or a requested role the user holds', async () => {
    await createUser(prisma, { email: 'both@example.test', roles: ['LECTURER', 'STUDENT'] });
    expect((await login('both@example.test').expect(200)).body.activeRole).toBe('STUDENT');
    const asLecturer = await http
      .post('/api/v1/auth/login')
      .send({ email: 'both@example.test', password: TEST_PASSWORD, client: 'MOBILE', role: 'LECTURER' })
      .expect(200);
    expect(asLecturer.body.activeRole).toBe('LECTURER');
    await http
      .post('/api/v1/auth/login')
      .send({ email: 'both@example.test', password: TEST_PASSWORD, client: 'MOBILE', role: 'REGISTRAR' })
      .expect(403);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const res = await http
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.test', password: 'x', client: 'WEB', isAdmin: true })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('access tokens and /auth/me', () => {
  it('returns the user, roles and the permissions of the active role', async () => {
    await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
    const { accessToken } = (await login('lecturer@example.test').expect(200)).body;
    const me = await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(me.body.user.email).toBe('lecturer@example.test');
    expect(me.body.activeRole).toBe('LECTURER');
    expect(me.body.permissions).toContain('attendance.open');
    expect(me.body.permissions).not.toContain('checkins.create');
  });

  it('refuses missing, tampered and revoked-session tokens', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const { accessToken } = (await login('student@example.test').expect(200)).body;
    await http.get('/api/v1/auth/me').expect(401);
    const [h, p, s] = accessToken.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'SUPER_ADMIN' }),
    ).toString('base64url');
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${h}.${forged}.${s}`).expect(401);

    await http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(204);
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
  });

  it('stops working as soon as the account is suspended', async () => {
    const user = await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const { accessToken } = (await login('student@example.test').expect(200)).body;
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
  });
});

describe('refresh tokens', () => {
  it('rotates on every use, and a reused old token ends the whole session', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const first = (await login('student@example.test').expect(200)).body;

    const second = (
      await http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)
    ).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${second.accessToken}`).expect(200);

    // Someone replays the first (already used) token: the session ends for everyone holding it.
    await http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await http.post('/api/v1/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${second.accessToken}`).expect(401);
    expect(await prisma.auditLog.count({ where: { action: 'auth.refresh_token.reuse_detected' } })).toBe(1);
  });

  it('uses the cookie for the web dashboard, only from the dashboard origin', async () => {
    await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
    const cookie = refreshCookie(await login('lecturer@example.test', 'WEB').expect(200))!.split(';')[0]!;

    const foreign = await http
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example.test')
      .expect(403);
    expect(foreign.body.code).toBe('ORIGIN_REJECTED');

    const ok = await http
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', WEB_ORIGIN)
      .expect(200);
    expect(ok.body.refreshToken).toBeUndefined();
    expect(refreshCookie(ok)).toBeTruthy();
  });

  it('will not accept a web refresh token from a mobile client', async () => {
    await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
    const cookie = refreshCookie(await login('lecturer@example.test', 'WEB').expect(200))!;
    const token = cookie.split(';')[0]!.slice('as_refresh='.length);
    await http.post('/api/v1/auth/refresh').send({ refreshToken: token }).expect(401);
  });

  it('ends the session at refresh time if the role was revoked', async () => {
    const user = await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
    const { refreshToken } = (await login('lecturer@example.test').expect(200)).body;
    await prisma.userRole.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date(), revokedById: user.id },
    });
    await http.post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);
  });
});

describe('password reset and change', () => {
  it('says the same thing for unknown emails, and only emails real accounts', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const unknown = await http
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'nobody@example.test' })
      .expect(202);
    expect(sentMail).toHaveLength(0);
    const known = await http
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'student@example.test' })
      .expect(202);
    expect(known.body).toEqual(unknown.body);
    await new Promise((r) => setTimeout(r, 20)); // reset email is sent without blocking the response
    expect(sentMail).toHaveLength(1);
  });

  it('resets the password, ends every session and makes the old password stop working', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const session = (await login('student@example.test').expect(200)).body;
    await http.post('/api/v1/auth/password/forgot').send({ email: 'student@example.test' }).expect(202);
    await new Promise((r) => setTimeout(r, 20));

    const token = tokenFromMail('/reset-password');
    await http
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'new-river-mango-77' })
      .expect(204);

    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${session.accessToken}`).expect(401);
    await http.post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);
    await login('student@example.test').expect(401);
    await login('student@example.test', 'MOBILE', 'new-river-mango-77').expect(200);
    await http
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'another-new-one-88' })
      .expect(400);
  });

  it('changes the password, keeping this session and ending the others', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    const here = (await login('student@example.test').expect(200)).body;
    const elsewhere = (await login('student@example.test').expect(200)).body;
    const auth = { Authorization: `Bearer ${here.accessToken}` };

    const wrong = await http
      .post('/api/v1/auth/password/change')
      .set(auth)
      .send({ currentPassword: 'not-it-at-all-1', newPassword: 'new-river-mango-77' })
      .expect(400);
    expect(wrong.body.code).toBe('CURRENT_PASSWORD_INCORRECT');

    await http
      .post('/api/v1/auth/password/change')
      .set(auth)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'new-river-mango-77' })
      .expect(204);
    await http.get('/api/v1/auth/me').set(auth).expect(200);
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${elsewhere.accessToken}`).expect(401);
  });
});

describe('two-step sign-in (staff roles)', () => {
  async function enrol(email: string) {
    const start = (await login(email, 'WEB').expect(200)).body;
    expect(start).toMatchObject({ mfaRequired: true, enrollmentRequired: true });
    expect(start.accessToken).toBeUndefined();
    const { secret, otpauthUri } = (
      await http.post('/api/v1/auth/mfa/enroll').send({ mfaToken: start.mfaToken }).expect(200)
    ).body;
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/AttendSure:/);
    const code = generateSync({ secret });
    const done = await http
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: start.mfaToken, code })
      .expect(200);
    return { secret, code, body: done.body };
  }

  it('makes a registrar set up an authenticator app, then returns 10 recovery codes once', async () => {
    const user = await createUser(prisma, { email: 'registrar@example.test', roles: ['REGISTRAR'] });
    const { body } = await enrol('registrar@example.test');
    expect(body.accessToken).toBeTruthy();
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.recoveryCodes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.mfaEnabledAt).not.toBeNull();
    expect(stored.mfaSecretEnc).not.toContain(body.recoveryCodes[0]);
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
  });

  it('asks for a code at every later sign-in and refuses a code that was already used', async () => {
    const user = await createUser(prisma, { email: 'admin@example.test', roles: ['UNIVERSITY_ADMIN'] });
    const { secret, code: usedCode } = await enrol('admin@example.test');

    const next = (await login('admin@example.test', 'WEB').expect(200)).body;
    expect(next).toMatchObject({ mfaRequired: true, enrollmentRequired: false });
    const replay = await http
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: next.mfaToken, code: usedCode })
      .expect(401);
    expect(replay.body.code).toBe('INVALID_MFA_CODE');

    // Pretend 30 seconds have passed: a fresh code is accepted.
    await prisma.user.update({ where: { id: user.id }, data: { mfaLastTimeStep: 0 } });
    await http
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: next.mfaToken, code: generateSync({ secret }) })
      .expect(200);
    // The same challenge cannot open a second session.
    await http
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: next.mfaToken, code: generateSync({ secret }) })
      .expect(401);
  });

  it('accepts each recovery code once', async () => {
    await createUser(prisma, { email: 'registrar@example.test', roles: ['REGISTRAR'] });
    const { body } = await enrol('registrar@example.test');
    const code = body.recoveryCodes[0];

    const first = (await login('registrar@example.test', 'WEB').expect(200)).body;
    await http
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: first.mfaToken, recoveryCode: code })
      .expect(200);
    const second = (await login('registrar@example.test', 'WEB').expect(200)).body;
    await http
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: second.mfaToken, recoveryCode: code })
      .expect(401);
  });

  it('ends a sign-in attempt after 5 wrong codes', async () => {
    await createUser(prisma, { email: 'registrar@example.test', roles: ['REGISTRAR'] });
    const { secret } = await enrol('registrar@example.test');
    const attempt = (await login('registrar@example.test', 'WEB').expect(200)).body;
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await http
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: attempt.mfaToken, code: '000000' });
      codes.push(res.body.code);
    }
    expect(codes.slice(0, 4).every((c) => c === 'INVALID_MFA_CODE')).toBe(true);
    expect(codes[4]).toBe('MFA_CHALLENGE_EXPIRED');
    const after = await http
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: attempt.mfaToken, code: generateSync({ secret }) })
      .expect(401);
    expect(after.body.code).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('does not accept a two-step token as an access token', async () => {
    await createUser(prisma, { email: 'registrar@example.test', roles: ['REGISTRAR'] });
    const { mfaToken } = (await login('registrar@example.test', 'WEB').expect(200)).body;
    await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${mfaToken}`).expect(401);
  });

  it('does not ask students or lecturers for a code', async () => {
    await createUser(prisma, { email: 'lecturer@example.test', roles: ['LECTURER'] });
    const res = await login('lecturer@example.test', 'WEB').expect(200);
    expect(res.body.mfaRequired).toBeUndefined();
    expect(res.body.accessToken).toBeTruthy();
  });
});

describe('audit trail', () => {
  it('records sign-ins and failures without storing passwords', async () => {
    await createUser(prisma, { email: 'student@example.test', roles: ['STUDENT'] });
    await login('student@example.test', 'MOBILE', 'wrong-password-zz').expect(401);
    await login('student@example.test').expect(200);
    const entries = await prisma.auditLog.findMany({ orderBy: { occurredAt: 'asc' } });
    expect(entries.map((e) => e.action)).toEqual(['auth.login.failed', 'auth.login.succeeded']);
    expect(JSON.stringify(entries)).not.toContain('wrong-password-zz');
    expect(JSON.stringify(entries)).not.toContain(TEST_PASSWORD);
  });
});
