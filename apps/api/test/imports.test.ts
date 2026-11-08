import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { StorageService } from '../src/infrastructure/storage/storage.service.js';
import { ImportsService } from '../src/modules/imports/imports.service.js';
import { readRows } from '../src/modules/imports/spreadsheet.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake students: 99xxxxxx Student IDs and example.test emails (CLAUDE.md rule 2).
const sentMail: MailMessage[] = [];
let mailFails = false;
const fakeMail = {
  send: async (m: MailMessage) => {
    if (mailFails) throw new Error('mail server down (test)');
    sentMail.push(m);
  },
  onModuleDestroy: () => undefined,
};
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let registrar: Record<string, string>;
let registrarId: string;

const HEADER =
  'student_number,full_name,email,phone,programme_code,level_code,academic_year,semester_number,status';
const row = (
  n: string,
  name: string,
  email: string,
  extra: Partial<Record<'phone' | 'programme' | 'semester', string>> = {},
) =>
  [
    n,
    name,
    email,
    extra.phone ?? '0245550101',
    extra.programme ?? 'TP',
    'L1',
    'TEST-2030',
    extra.semester ?? '1',
    '',
  ].join(',');
const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join('\n') + '\n');

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
  sentMail.length = 0;
  mailFails = false;
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  const signedIn = await signInAs(app, prisma, 'registrar@example.test', ['REGISTRAR']);
  registrar = signedIn.auth;
  registrarId = signedIn.user.id;
  const faculty = await prisma.faculty.create({ data: { code: 'TF', name: 'Test Faculty' } });
  const department = await prisma.department.create({
    data: { facultyId: faculty.id, code: 'TD', name: 'Test Department' },
  });
  await prisma.programme.create({
    data: { departmentId: department.id, code: 'TP', name: 'Test Programme' },
  });
  await prisma.academicLevel.create({ data: { code: 'L1', name: 'Level One (test)', sortOrder: 1 } });
  const year = await prisma.academicYear.create({
    data: { label: 'TEST-2030', startDate: new Date('2030-08-01'), endDate: new Date('2031-07-31') },
  });
  await prisma.semester.create({
    data: {
      academicYearId: year.id,
      number: 1,
      name: 'First (test)',
      startDate: new Date('2030-08-15'),
      endDate: new Date('2030-12-20'),
    },
  });
});

const upload = (bytes: Buffer, name = 'students.csv', auth = registrar) =>
  http.post('/api/v1/imports/students').set(auth).attach('file', bytes, name);
const get = (path: string) => http.get(`/api/v1${path}`).set(registrar);
const post = (path: string, body: object = {}) => http.post(`/api/v1${path}`).set(registrar).send(body);

async function emailsSettled(id: string) {
  const imports = app.get(ImportsService);
  for (let i = 0; i < 200 && imports.isSending(id); i++) await new Promise((r) => setTimeout(r, 25));
  expect(imports.isSending(id)).toBe(false);
}

describe('templates', () => {
  it('downloads the student template as CSV and as Excel', async () => {
    const asCsv = await get('/imports/students/template?format=csv').expect(200);
    expect(asCsv.headers['content-disposition']).toContain('students-import-template.csv');
    expect(asCsv.text.trim()).toBe(HEADER);
    const asXlsx = await get('/imports/students/template?format=xlsx').responseType('blob').expect(200);
    const read = await readRows(asXlsx.body as Buffer, 'xlsx');
    expect(read.headers.join(',')).toBe(HEADER);
    await get('/imports/lecturers/template').expect(404);
  });
});

describe('uploading and checking a file', () => {
  it('checks every row and saves nothing until confirmed', async () => {
    await post('/students', {
      studentNumber: '99000009',
      fullName: 'Already Here',
      email: 'already@example.test',
      phone: '0245550109',
      programmeId: (await prisma.programme.findFirstOrThrow()).id,
      levelId: (await prisma.academicLevel.findFirstOrThrow()).id,
      academicYearId: (await prisma.academicYear.findFirstOrThrow()).id,
      semesterId: (await prisma.semester.findFirstOrThrow()).id,
    }).expect(201);
    const file = csv(
      row('99000001', 'Valid One', 'one@example.test'),
      row('9900002', 'Short Number', 'two@example.test'),
      row('99000003', 'Unknown Programme', 'three@example.test', { programme: 'NOPE' }),
      row('99000004', 'Twin A', 'twin-a@example.test'),
      row('99000004', 'Twin B', 'twin-b@example.test'),
      row('99000009', 'Taken Number', 'four@example.test'),
      row('99000005', 'Bad Phone', 'five@example.test', { phone: '12345' }),
      ',,,,,,,,',
      row('99000006', 'No Semester Two', 'six@example.test', { semester: '2' }),
    );
    const res = await upload(file).expect(201);
    expect(res.body).toMatchObject({
      status: 'VALIDATED',
      format: 'CSV',
      fileName: 'students.csv',
      totalRows: 8,
      validRows: 1,
      invalidRows: 4,
      duplicateRows: 3,
      importedRows: 0,
    });
    expect(await prisma.studentProfile.count()).toBe(1);

    const invalid = (await get(`/imports/students/${res.body.id}/rows?status=INVALID`).expect(200)).body.data;
    const codes = Object.fromEntries(
      invalid.map((r: { rowNumber: number; errors: { code: string }[] }) => [
        r.rowNumber,
        r.errors.map((e) => e.code),
      ]),
    );
    expect(codes).toEqual({
      3: ['INVALID_VALUE'],
      4: ['UNKNOWN_PROGRAMME'],
      8: ['INVALID_VALUE'],
      10: ['UNKNOWN_SEMESTER'],
    });
    const dups = (await get(`/imports/students/${res.body.id}/rows?status=DUPLICATE_IN_FILE`).expect(200))
      .body.data;
    expect(dups.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([5, 6]);
    const existing = (
      await get(`/imports/students/${res.body.id}/rows?status=DUPLICATE_EXISTING`).expect(200)
    ).body.data;
    expect(existing[0]).toMatchObject({ rowNumber: 7, errors: [{ code: 'STUDENT_NUMBER_IN_USE' }] });
    const page = (await get(`/imports/students/${res.body.id}/rows?limit=3`).expect(200)).body;
    expect(page.data).toHaveLength(3);
    expect(page.nextAfter).toBe(4);
  });

  it('refuses files that are not CSV or Excel, have the wrong columns, or are too big', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect((await upload(png, 'students.csv').expect(400)).body.code).toBe('UNSUPPORTED_FILE_TYPE');
    const wrong = await upload(Buffer.from('student_number,name\n99000001,X Y\n')).expect(400);
    expect(wrong.body).toMatchObject({ code: 'COLUMNS_DO_NOT_MATCH' });
    expect(wrong.body.errors.missing).toContain('full_name');
    expect(wrong.body.errors.unknown).toEqual(['name']);
    expect((await upload(csv()).expect(400)).body.code).toBe('EMPTY_FILE');
    const many = csv(
      ...Array.from({ length: 5001 }, (_, i) => row(String(99100000 + i), 'Many Rows', `m${i}@example.test`)),
    );
    expect((await upload(many).expect(400)).body.code).toBe('TOO_MANY_ROWS');
    await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)).expect(413);
    await http.post('/api/v1/imports/students').set(registrar).expect(400);
    expect(await prisma.importBatch.count()).toBe(0);
  });

  it('reads Excel files, restoring phone numbers Excel turned into numbers', async () => {
    const cell = (value: string | number) => ({ value, type: typeof value === 'number' ? Number : String });
    const sheet = await writeXlsxFile([
      HEADER.split(',').map(cell),
      [99000001, 'Excel Student', 'excel@example.test', 245550101, 'tp', 'L1', 'TEST-2030', 1, ''].map(cell),
      [
        99000002,
        'Plus Number',
        'plus@example.test',
        233245550102,
        'TP',
        'L1',
        'TEST-2030',
        1,
        'deferred',
      ].map(cell),
    ]).toBuffer();
    const res = await upload(sheet, 'students.xlsx').expect(201);
    expect(res.body).toMatchObject({ format: 'XLSX', validRows: 2, invalidRows: 0 });
    await post(`/imports/students/${res.body.id}/confirm`).expect(200);
    await emailsSettled(res.body.id);
    const students = await prisma.studentProfile.findMany({
      include: { user: true },
      orderBy: { studentNumber: 'asc' },
    });
    expect(students.map((s) => [s.studentNumber, s.user.phone, s.status])).toEqual([
      ['99000001', '0245550101', 'ACTIVE'],
      ['99000002', '+233245550102', 'DEFERRED'],
    ]);
  });
});

describe('confirming', () => {
  it('imports valid rows in one go, audits each student and sends activation emails', async () => {
    const res = await upload(
      csv(
        row('99000001', 'Valid One', 'one@example.test'),
        row('99000002', 'Valid Two', 'two@example.test'),
        row('1', 'Bad', 'bad@example.test'),
      ),
    ).expect(201);
    const done = (await post(`/imports/students/${res.body.id}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', importedRows: 2, decidedById: registrarId });
    await emailsSettled(res.body.id);
    expect((await get(`/imports/students/${res.body.id}`).expect(200)).body.activationEmails).toEqual({
      pending: 0,
      sent: 2,
      failed: 0,
    });
    expect(sentMail.map((m) => m.to).sort()).toEqual(['one@example.test', 'two@example.test']);
    const audits = await prisma.auditLog.findMany({ where: { action: 'students.registered' } });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.after).toMatchObject({ importBatchId: res.body.id });
    expect(await prisma.auditLog.count({ where: { action: 'imports.confirmed' } })).toBe(1);
    expect((await post(`/imports/students/${res.body.id}/confirm`).expect(409)).body.code).toBe(
      'NOT_PENDING',
    );
    expect((await post(`/imports/students/${res.body.id}/cancel`).expect(409)).body.code).toBe('NOT_PENDING');
  });

  it('re-checks at confirmation, so a student registered meanwhile is not created twice', async () => {
    const res = await upload(
      csv(row('99000001', 'Valid One', 'one@example.test'), row('99000002', 'Valid Two', 'two@example.test')),
    ).expect(201);
    expect(res.body.validRows).toBe(2);
    await post('/students', {
      studentNumber: '99000002',
      fullName: 'Registered Meanwhile',
      email: 'meanwhile@example.test',
      phone: '0245550110',
      programmeId: (await prisma.programme.findFirstOrThrow()).id,
      levelId: (await prisma.academicLevel.findFirstOrThrow()).id,
      academicYearId: (await prisma.academicYear.findFirstOrThrow()).id,
      semesterId: (await prisma.semester.findFirstOrThrow()).id,
    }).expect(201);
    const done = (await post(`/imports/students/${res.body.id}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    const rows = (await get(`/imports/students/${res.body.id}/rows`).expect(200)).body.data;
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['IMPORTED', 'DUPLICATE_EXISTING']);
    expect(await prisma.studentProfile.count()).toBe(2);
  });

  it('records failed activation emails and sends them again on request', async () => {
    mailFails = true;
    const res = await upload(csv(row('99000001', 'Valid One', 'one@example.test'))).expect(201);
    await post(`/imports/students/${res.body.id}/confirm`).expect(200);
    await emailsSettled(res.body.id);
    expect((await get(`/imports/students/${res.body.id}`).expect(200)).body.activationEmails).toEqual({
      pending: 0,
      sent: 0,
      failed: 1,
    });
    mailFails = false;
    await post(`/imports/students/${res.body.id}/activation-emails`).expect(200);
    await emailsSettled(res.body.id);
    expect((await get(`/imports/students/${res.body.id}`).expect(200)).body.activationEmails).toEqual({
      pending: 0,
      sent: 1,
      failed: 0,
    });
    expect(sentMail).toHaveLength(1);
  });

  it('cancels a checked file and deletes the stored copy', async () => {
    const res = await upload(csv(row('99000001', 'Valid One', 'one@example.test'))).expect(201);
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { file: true },
    });
    expect((await post(`/imports/students/${res.body.id}/cancel`).expect(200)).body.status).toBe('CANCELLED');
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: batch.fileId } })).status).toBe(
      'REMOVED',
    );
    await expect(app.get(StorageService).get(batch.file.key)).rejects.toThrow();
    expect((await post(`/imports/students/${res.body.id}/confirm`).expect(409)).body.code).toBe(
      'NOT_PENDING',
    );
    expect(await prisma.studentProfile.count()).toBe(0);
  });
});

describe('error reports', () => {
  it('lists the rows that were not imported, with problems, and neutralises spreadsheet formulas', async () => {
    const res = await upload(
      csv(row('99000001', 'Valid One', 'one@example.test'), row('123', '=1+1', 'formula@example.test')),
    ).expect(201);
    const report = await get(`/imports/students/${res.body.id}/error-report?format=csv`).expect(200);
    const read = await readRows(Buffer.from(report.text), 'csv');
    expect(read.headers.slice(-2)).toEqual(['row_number', 'problems']);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.values).toMatchObject({ student_number: '123', full_name: '=1+1', row_number: '3' });
    expect(report.text).toContain("'=1+1");
    expect(read.rows[0]!.values.problems).toContain('8-digit Student ID');
    // The fixed report can be uploaded again as it is: the extra columns are accepted.
    await upload(Buffer.from(report.text)).expect(201);
  });
});

describe('access', () => {
  it('is limited to staff with the import permission', async () => {
    const { auth } = await signInAs(app, prisma, 'lecturer@example.test', ['LECTURER']);
    await upload(csv(row('99000001', 'Valid One', 'one@example.test')), 'students.csv', auth).expect(403);
    await http.get('/api/v1/imports/students').set(auth).expect(403);
  });
});
