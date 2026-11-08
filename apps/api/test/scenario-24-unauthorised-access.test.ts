import { type INestApplication, RequestMethod } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DEFAULT_ROLE_PERMISSIONS, ROLE_KEYS, type RoleKey } from '@attendsure/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { ACCESS_RULE, type AccessRule } from '../src/modules/authorization/access.decorators.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

/**
 * Test scenario 24 (docs/TESTING.md): an unauthorised user tries another role's API.
 * Routes are discovered from the running app, so every endpoint added later is covered automatically:
 *  - every non-public route refuses a request without sign-in (401);
 *  - every permission-protected route refuses each role whose default grants lack a required permission (403),
 *    before reaching the handler: the request body is empty, so a 400 would mean validation ran first.
 */

interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'delete' | 'patch';
  path: string;
  rule: AccessRule | undefined;
  name: string;
}

const METHODS: Partial<Record<RequestMethod, RouteInfo['method']>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};
const UNPREFIXED = new Set(['health/live', 'health/ready']);
const SAMPLE_PARAMS: Record<string, string> = { key: 'REGISTRAR' };
const SAMPLE_ID = '01960000-0000-7000-8000-0000000000aa';

const SIGN_IN_ROLES = ROLE_KEYS.filter((r): r is RoleKey => r !== 'COURSE_REP');

/** Whether a role's default grants include every permission a route requires. */
function roleMayUse(role: RoleKey, route: RouteInfo): boolean {
  const keys = route.rule?.kind === 'permissions' ? route.rule.keys : [];
  const held = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]);
  return keys.every((k) => held.has(k));
}

const fakeMail = { send: async (_m: MailMessage) => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
const routes: RouteInfo[] = [];

function join(...parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p && p !== '/')
    .map((p) => p.replace(/^\/|\/$/g, ''))
    .join('/');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);

  const reflector = app.get(Reflector);
  for (const wrapper of app.get(DiscoveryService).getControllers()) {
    const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
    if (!controller) continue;
    const base = Reflect.getMetadata('path', controller) as string | undefined;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const sub = Reflect.getMetadata('path', handler) as string | undefined;
      const verb = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
      if (sub === undefined || verb === undefined) continue;
      const raw = join(base, sub);
      const filled = raw.replace(/:(\w+)/g, (_m, param: string) => SAMPLE_PARAMS[param] ?? SAMPLE_ID);
      routes.push({
        method: METHODS[verb] ?? 'get',
        path: UNPREFIXED.has(raw) ? `/${filled}` : `/api/v1/${filled}`,
        rule: reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_RULE, [handler, controller]),
        name: `${controller.name}.${name}`,
      });
    }
  }
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
});

describe('scenario 24: unauthorised access is refused on every endpoint', () => {
  it('found the Phase 1 endpoints', () => {
    // 2 health + 11 auth + 9 users + 2 roles + 1 audit-log routes.
    expect(routes.length).toBeGreaterThanOrEqual(25);
    expect(routes.filter((r) => r.rule?.kind === 'permissions').length).toBeGreaterThanOrEqual(12);
  });

  it('refuses every non-public endpoint without sign-in', async () => {
    const failures: string[] = [];
    for (const route of routes.filter((r) => r.rule?.kind !== 'public')) {
      const res = await request(app.getHttpServer())[route.method](route.path).send({});
      if (res.status !== 401)
        failures.push(`${route.name} ${route.method.toUpperCase()} ${route.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('refuses every role that lacks a required permission, before any validation or data access', async () => {
    const protectedRoutes = routes.filter((r) => r.rule?.kind === 'permissions');
    const failures: string[] = [];
    const checked = new Set<string>();

    for (const role of ROLE_KEYS.filter((r): r is RoleKey => r !== 'COURSE_REP')) {
      const { auth } = await signInAs(app, prisma, `${role.toLowerCase()}@example.test`, [role]);
      const held = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]);
      for (const route of protectedRoutes) {
        const keys = route.rule?.kind === 'permissions' ? route.rule.keys : [];
        if (keys.every((k) => held.has(k))) continue; // this role may use it
        checked.add(route.name);
        const res = await request(app.getHttpServer())[route.method](route.path).set(auth).send({});
        if (res.status !== 403 || res.body.code !== 'PERMISSION_DENIED') {
          failures.push(
            `${role} → ${route.name} ${route.method.toUpperCase()} ${route.path}: ${res.status} ${res.body.code}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
    // Every protected route that some role may not use was tried by such a role. (A route whose
    // permission every role holds, such as viewing rooms, still needs sign-in: see the 401 test.)
    const restrictable = protectedRoutes.filter((r) => SIGN_IN_ROLES.some((role) => !roleMayUse(role, r)));
    expect([...checked].sort()).toEqual(restrictable.map((r) => r.name).sort());
  });

  it('records every refusal in the audit log', async () => {
    const { auth, user } = await signInAs(app, prisma, 'student@example.test', ['STUDENT']);
    const adminOnly = routes.filter((r) => r.rule?.kind === 'permissions' && !roleMayUse('STUDENT', r));
    for (const route of adminOnly) {
      await request(app.getHttpServer())[route.method](route.path).set(auth).send({}).expect(403);
    }
    expect(await prisma.auditLog.count({ where: { action: 'authz.denied', actorUserId: user.id } })).toBe(
      adminOnly.length,
    );
  });
});
