import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import readXlsxFile from 'read-excel-file/node';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { Clock, FakeClock } from '../src/infrastructure/clock/clock.js';
import { MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { StorageService } from '../src/infrastructure/storage/storage.service.js';
import { PermissionService } from '../src/modules/authorization/permission.service.js';
import { FilesService } from '../src/modules/files/files.service.js';
import { ExportsService } from '../src/modules/reports/exports.service.js';
import { buildClass, inRoom, signedCheckIn } from './attendance-fixture.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Phase 7 step 2: report exports. Obviously fake data: the fixture's class on Tue 2030-08-20, held,
// with student 1 present, student 2 late and student 3 absent. One student's name is set to start with
// "=" to check that spreadsheet formulas are neutralised.
const fakeMail = { send: async () => undefined, onModuleDestroy: () => undefined };
const clock = new FakeClock('2030-08-20T09:58:00Z');
const at = (iso: string) => clock.set(iso);

let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let exports: ExportsService;
let c: Awaited<ReturnType<typeof buildClass>>;
let semesterId: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  http = request(app.getHttpServer());
  exports = app.get(ExportsService);
}, 60_000);

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  at('2030-08-20T09:58:00Z');
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  c = await buildClass(app, prisma, http, { students: 3 });
  semesterId = (await prisma.semester.findFirstOrThrow()).id;
  await prisma.user.update({
    where: { id: c.students[2]!.userId },
    data: { fullName: '=1+2 Test Student (test)' },
  });
  at('2030-08-20T10:00:00Z');
  const id = (
    await http
      .post(`/api/v1/class-sessions/${c.classId}/attendance/open`)
      .set(c.lecturer.auth)
      .send({ startClass: true })
      .expect(201)
  ).body.id;
  const qr = async () =>
    (await http.get(`/api/v1/attendance-sessions/${id}/qr`).set(c.lecturer.auth).expect(200)).body
      .token as string;
  at('2030-08-20T10:01:00Z');
  await signedCheckIn(http, clock, c.students[0]!, inRoom(await qr())).expect(200);
  at('2030-08-20T10:16:00Z');
  await signedCheckIn(http, clock, c.students[1]!, inRoom(await qr())).expect(200);
  at('2030-08-20T10:19:00Z');
  await http.post(`/api/v1/attendance-sessions/${id}/close`).set(c.lecturer.auth).send({}).expect(200);
  at('2030-08-20T11:30:00Z');
  await http.post(`/api/v1/class-sessions/${c.classId}/end`).set(c.lecturer.auth).send({}).expect(200);
  at('2030-08-21T09:00:00Z');
}, 120_000);

const ask = (auth: Record<string, string>, body: object) =>
  http.post('/api/v1/reports/exports').set(auth).send(body);
const summary = (format: string) => ({
  reportType: 'SECTION_SUMMARY',
  format,
  params: { sectionId: c.sectionId },
});
async function made(auth: Record<string, string>, body: object) {
  const queued = (await ask(auth, body).expect(201)).body;
  expect(queued.status).toBe('QUEUED');
  await exports.make(queued.id);
  const ready = (await http.get(`/api/v1/reports/exports/${queued.id}`).set(auth).expect(200)).body;
  const row = await prisma.reportExport.findUniqueOrThrow({ where: { id: queued.id } });
  return { ready, bytes: row.fileId ? await app.get(FilesService).read(row.fileId) : null, row };
}

describe('a lecturer’s section summary', () => {
  it('as CSV: the real counts, formulas neutralised, logged when asked, made and downloaded', async () => {
    const { ready, bytes, row } = await made(c.lecturer.auth, summary('CSV'));
    expect(ready).toMatchObject({
      status: 'READY',
      rowCount: 3,
      containsPersonalData: true,
      downloadCount: 0,
    });
    const csv = bytes!.toString('utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(
      'Student ID,Name,Enrolled,Counted,Present,Late,Absences,Excused,Undecided,Cancelled,Attendance',
    );
    expect(csv).toContain('99000001,Test Person,Yes,1,1,0,0,0,0,0,100%');
    expect(csv).toContain('99000002,Test Person,Yes,1,0,1,0,0,0,0,100%');
    expect(csv).toContain("'=1+2 Test Student (test)"); // never runs as a formula
    expect(csv).toContain('Contains personal data');
    // The lecturer is told it is ready; downloading is logged and counted.
    expect(
      await prisma.notification.count({ where: { userId: c.lecturer.userId, category: 'REPORT_READY' } }),
    ).toBe(1);
    const link = (
      await http.get(`/api/v1/reports/exports/${row.id}/download`).set(c.lecturer.auth).expect(200)
    ).body;
    expect(link).toMatchObject({ fileName: expect.stringMatching(/\.csv$/), mimeType: 'text/csv' });
    expect(link.url).toBeTruthy();
    const actions = (await prisma.auditLog.findMany({ where: { entityId: row.id } }))
      .map((a) => a.action)
      .sort();
    expect(actions).toEqual([
      'reports.export_downloaded',
      'reports.export_ready',
      'reports.export_requested',
    ]);
    expect((await prisma.reportExport.findUniqueOrThrow({ where: { id: row.id } })).downloadCount).toBe(1);
    // Making it again does nothing (a retried job).
    await exports.make(row.id);
    expect(await prisma.fileObject.count({ where: { purpose: 'EXPORT_FILE' } })).toBe(1);
  });

  it('as Excel: numbers as numbers, text neutralised', async () => {
    const { bytes } = await made(c.lecturer.auth, summary('XLSX'));
    expect(bytes!.subarray(0, 2).toString()).toBe('PK');
    const sheet = (await readXlsxFile(bytes!)) as unknown as { data: unknown[][] }[] | unknown[][];
    const rows = (
      Array.isArray(sheet[0]) ? sheet : (sheet as { data: unknown[][] }[])[0]!.data
    ) as unknown[][];
    const line = rows.find((r) => r[0] === '99000001')!;
    expect(line.slice(3, 7)).toEqual([1, 1, 0, 0]);
    expect(rows.some((r) => r[1] === "'=1+2 Test Student (test)")).toBe(true);
  });

  it('as PDF, and the register as a landscape PDF', async () => {
    const pdf = (await made(c.lecturer.auth, summary('PDF'))).bytes!;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const register = await made(c.lecturer.auth, {
      reportType: 'SECTION_REGISTER',
      format: 'PDF',
      params: { sectionId: c.sectionId },
    });
    expect(register.ready).toMatchObject({ status: 'READY', rowCount: 3 });
    expect(register.bytes!.subarray(0, 5).toString()).toBe('%PDF-');
    const csv = (
      await made(c.lecturer.auth, {
        reportType: 'SECTION_REGISTER',
        format: 'CSV',
        params: { sectionId: c.sectionId },
      })
    ).bytes!.toString('utf8');
    expect(csv).toContain('Student ID,Name,20 Aug,Attendance');
    expect(csv).toContain('99000001,Test Person,P,100%');
    expect(csv).toContain('99000002,Test Person,L,100%');
    expect(csv).toMatch(/99000003,'=1\+2 Test Student \(test\),A,0%/);
  });
});

describe('who may ask for what', () => {
  it('refuses at once what the person could not see on screen', async () => {
    await ask(c.otherLecturer.auth, summary('CSV')).expect(403); // not their section
    await ask(c.students[0]!.auth, summary('CSV')).expect(403);
    const registrar = await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR']);
    await ask(registrar.auth, summary('CSV')).expect(403); // no course reports
    await ask(c.lecturer.auth, {
      reportType: 'ATTENDANCE_ANALYTICS',
      format: 'CSV',
      params: { semesterId },
    }).expect(403);
    await ask(c.lecturer.auth, {
      reportType: 'STUDENT_ENROLMENTS',
      format: 'CSV',
      params: { semesterId },
    }).expect(403);
    await ask(c.lecturer.auth, {
      reportType: 'SECTION_SUMMARY',
      format: 'DOCX',
      params: { sectionId: c.sectionId },
    }).expect(400);
    expect(await prisma.reportExport.count()).toBe(0);

    // The Registrar's student and enrolment list.
    const list = await made(registrar.auth, {
      reportType: 'STUDENT_ENROLMENTS',
      format: 'CSV',
      params: { semesterId },
    });
    expect(list.ready.rowCount).toBe(3);
    expect(list.bytes!.toString('utf8')).toContain(
      '99000001,Test Person,TP,L1,ACTIVE,TST101 · Test Course,A,ENROLLED',
    );
    // Administrators' analytics by lecturer name people, so they are personal data.
    const byLecturer = await made(c.admin.auth, {
      reportType: 'ATTENDANCE_ANALYTICS',
      format: 'CSV',
      params: { semesterId, groupBy: 'lecturer' },
    });
    expect(byLecturer.ready).toMatchObject({ status: 'READY', containsPersonalData: true, rowCount: 1 });
    const byDept = await made(c.admin.auth, {
      reportType: 'CLASS_OPERATIONS',
      format: 'XLSX',
      params: { semesterId },
    });
    expect(byDept.ready).toMatchObject({ status: 'READY', containsPersonalData: false });
  });

  it('files that name people need the personal-data export permission; the same report without names does not', async () => {
    // The Super Admin can take this permission away from administrators (role permissions are configurable).
    await prisma.rolePermission.deleteMany({
      where: { role: { key: 'UNIVERSITY_ADMIN' }, permission: { key: 'reports.export_personal' } },
    });
    await app.get(PermissionService).invalidate('UNIVERSITY_ADMIN');
    expect(
      (
        await ask(c.admin.auth, {
          reportType: 'ATTENDANCE_ANALYTICS',
          format: 'CSV',
          params: { semesterId, groupBy: 'lecturer' },
        }).expect(403)
      ).body.code,
    ).toBe('PERSONAL_DATA_EXPORT_DENIED');
    await ask(c.admin.auth, summary('CSV')).expect(403);
    await ask(c.admin.auth, {
      reportType: 'ATTENDANCE_ANALYTICS',
      format: 'CSV',
      params: { semesterId, groupBy: 'department' },
    }).expect(201);
  });

  it('nobody else sees or downloads my file; the export log is for people who read the audit log', async () => {
    const { row } = await made(c.lecturer.auth, summary('CSV'));
    await http.get(`/api/v1/reports/exports/${row.id}`).set(c.otherLecturer.auth).expect(404);
    await http.get(`/api/v1/reports/exports/${row.id}/download`).set(c.admin.auth).expect(404);
    expect(
      (await http.get('/api/v1/reports/exports').set(c.otherLecturer.auth).expect(200)).body.data,
    ).toEqual([]);
    await http.get('/api/v1/reports/exports?view=ALL').set(c.lecturer.auth).expect(403);
    const super_ = await signInAs(app, prisma, 'super@example.test', ['SUPER_ADMIN']);
    const log = (await http.get('/api/v1/reports/exports?view=ALL').set(super_.auth).expect(200)).body.data;
    expect(log).toEqual([
      expect.objectContaining({ id: row.id, requestedBy: expect.any(String), containsPersonalData: true }),
    ]);
  });

  it('a person who loses the role before the file is made gets no file, and is told', async () => {
    const queued = (await ask(c.lecturer.auth, summary('CSV')).expect(201)).body;
    await prisma.userRole.updateMany({
      where: { userId: c.lecturer.userId },
      data: { revokedAt: new Date(), revokedById: c.admin.userId },
    });
    await exports.make(queued.id);
    const row = await prisma.reportExport.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row).toMatchObject({ status: 'FAILED', fileId: null });
    expect(row.error).toContain('no longer hold the role');
    expect(
      await prisma.notification.count({ where: { userId: c.lecturer.userId, category: 'REPORT_FAILED' } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'reports.export_failed', entityId: queued.id } }),
    ).toBe(1);
  });
});

describe('retention', () => {
  it('deletes the file after 7 days and keeps the log; a download then says it has gone', async () => {
    const { row } = await made(c.lecturer.auth, summary('CSV'));
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: row.fileId! } });
    at('2030-08-27T09:00:00Z'); // 6 days: still there
    expect((await exports.expire()).expired).toBe(0);
    at('2030-08-28T09:01:00Z');
    expect((await exports.expire()).expired).toBe(1);
    expect(await prisma.reportExport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'EXPIRED',
    });
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: file.id } })).status).toBe('REMOVED');
    await expect(app.get(StorageService).get(file.key)).rejects.toThrow();
    expect(
      (await http.get(`/api/v1/reports/exports/${row.id}/download`).set(c.lecturer.auth).expect(410)).body
        .code,
    ).toBe('EXPIRED');
    expect(
      await prisma.auditLog.count({ where: { action: 'reports.export_expired', entityId: row.id } }),
    ).toBe(1);
  });
});
