import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { RiskFlagsService } from '../src/modules/risk-flags/risk-flags.service.js';
import { buildClass } from './attendance-fixture.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Security fix found while building the administrator dashboard (Phase 7 step 3): the risk-flag queue
// showed every flag in the university to any administrator, even one limited to a single department.
// Flags name students, so an administrator now sees only flags about students in their scope; flags
// about no student are for university-wide staff. Obviously fake data.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let c: Awaited<ReturnType<typeof buildClass>>;

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
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 1 });
});

describe('risk flags stay within the reviewer’s scope', () => {
  it('a department administrator sees and reviews only flags about their students', async () => {
    const flags = app.get(RiskFlagsService);
    await flags.raise({
      type: 'REPEATED_REJECTIONS',
      severity: 'MEDIUM',
      studentId: c.students[0]!.profileId,
      evidence: { test: true },
    });
    await flags.raise({ type: 'UNEXPECTED_BEACON', severity: 'LOW', evidence: { test: true } }); // about no student
    const dept = await prisma.department.findFirstOrThrow({ where: { code: 'TD' } });
    const faculty = await prisma.faculty.create({ data: { code: 'OF', name: 'Other Faculty (test)' } });
    const other = await prisma.department.create({
      data: { facultyId: faculty.id, code: 'OD', name: 'Other Department (test)' },
    });
    const ours = await signInAs(app, prisma, 'admin.td@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'DEPARTMENT', id: dept.id },
    });
    const theirs = await signInAs(app, prisma, 'admin.od@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'DEPARTMENT', id: other.id },
    });
    const list = async (auth: Record<string, string>) =>
      (await http.get('/api/v1/risk-flags').set(auth).expect(200)).body.data as {
        id: string;
        type: string;
      }[];

    expect((await list(c.admin.auth)).map((f) => f.type).sort()).toEqual([
      'REPEATED_REJECTIONS',
      'UNEXPECTED_BEACON',
    ]);
    expect((await list(ours.auth)).map((f) => f.type)).toEqual(['REPEATED_REJECTIONS']);
    expect(await list(theirs.auth)).toEqual([]);

    const flagged = (await list(ours.auth))[0]!;
    await http
      .post(`/api/v1/risk-flags/${flagged.id}/review`)
      .set(theirs.auth)
      .send({ decision: 'DISMISSED', note: 'Not mine (test)' })
      .expect(404);
    const beacon = (await list(c.admin.auth)).find((f) => f.type === 'UNEXPECTED_BEACON')!;
    await http
      .post(`/api/v1/risk-flags/${beacon.id}/review`)
      .set(ours.auth)
      .send({ decision: 'DISMISSED', note: 'Not mine (test)' })
      .expect(404);
    await http
      .post(`/api/v1/risk-flags/${flagged.id}/review`)
      .set(ours.auth)
      .send({ decision: 'DISMISSED', note: 'Checked with the lecturer (test)' })
      .expect(200);
  });
});
