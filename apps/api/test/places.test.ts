import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { type MailMessage, MailService } from '../src/infrastructure/mail/mail.service.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { resetDatabase, resetRedis, signInAs } from './fixtures.js';

// Obviously fake places and coordinates (CLAUDE.md rule 2): not a Knutsford survey.
const FAKE_FENCE = { lat: 1.5, lng: 2.5, radiusM: 300 };
const fakeMail = { send: async (_m: MailMessage) => undefined, onModuleDestroy: () => undefined };
let app: INestApplication;
let prisma: PrismaService;
let http: ReturnType<typeof request>;
let admin: Record<string, string>;

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
  // University Administrators hold classrooms.manage by default, with university-wide scope here.
  admin = (await signInAs(app, prisma, 'admin@example.test', ['UNIVERSITY_ADMIN'])).auth;
});

const post = (path: string, body: object, auth = admin) => http.post(`/api/v1${path}`).set(auth).send(body);
const patch = (path: string, body: object, auth = admin) => http.patch(`/api/v1${path}`).set(auth).send(body);
const get = (path: string, auth = admin) => http.get(`/api/v1${path}`).set(auth);

async function campusBuildingRoom() {
  const campus = (
    await post('/campuses', { code: 'tc', name: 'Test Campus', geofence: FAKE_FENCE }).expect(201)
  ).body;
  const building = (
    await post('/buildings', { campusId: campus.id, code: 'tb', name: 'Test Building' }).expect(201)
  ).body;
  const room = (
    await post('/classrooms', {
      buildingId: building.id,
      code: 'r-101',
      name: 'Test Room 101',
      floor: '1',
      capacity: 60,
    }).expect(201)
  ).body;
  return { campus, building, room };
}

describe('campuses, buildings and classrooms', () => {
  it('creates the hierarchy and lists rooms with their building, campus and geofence', async () => {
    const { campus, building, room } = await campusBuildingRoom();
    expect(campus).toMatchObject({ code: 'TC', geofence: FAKE_FENCE });
    expect(room.code).toBe('R-101');

    const rooms = (await get(`/classrooms?campusId=${campus.id}`).expect(200)).body;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      code: 'R-101',
      capacity: 60,
      building: { id: building.id, code: 'TB' },
      campus: { id: campus.id, code: 'TC' },
      geofence: FAKE_FENCE,
    });
    const actions = (await prisma.auditLog.findMany({ orderBy: { occurredAt: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['places.campus.created', 'places.building.created', 'places.classroom.created']);
  });

  it('uses the building geofence over the campus one, and clears it with null', async () => {
    const { building } = await campusBuildingRoom();
    const own = { lat: 1.6, lng: 2.6, radiusM: 80 };
    await patch(`/buildings/${building.id}`, { geofence: own }).expect(200);
    expect((await get('/classrooms').expect(200)).body[0].geofence).toEqual(own);
    await patch(`/buildings/${building.id}`, { geofence: null }).expect(200);
    expect((await get('/classrooms').expect(200)).body[0].geofence).toEqual(FAKE_FENCE);
  });

  it('rejects impossible coordinates and radii', async () => {
    await post('/campuses', {
      code: 'X1',
      name: 'Bad Lat',
      geofence: { lat: 95, lng: 0, radiusM: 100 },
    }).expect(400);
    await post('/campuses', {
      code: 'X2',
      name: 'Tiny Fence',
      geofence: { lat: 0, lng: 0, radiusM: 5 },
    }).expect(400);
  });

  it('keeps codes unique within their parent only', async () => {
    const { campus, building } = await campusBuildingRoom();
    const dupRoom = await post('/classrooms', {
      buildingId: building.id,
      code: 'R-101',
      name: 'Clash Room',
    }).expect(409);
    expect(dupRoom.body.code).toBe('CODE_IN_USE');
    const other = (
      await post('/buildings', { campusId: campus.id, code: 'TB2', name: 'Second Building' }).expect(201)
    ).body;
    await post('/classrooms', { buildingId: other.id, code: 'R-101', name: 'Same Code Elsewhere' }).expect(
      201,
    );
  });

  it('filters by capacity', async () => {
    const { building } = await campusBuildingRoom();
    await post('/classrooms', {
      buildingId: building.id,
      code: 'R-SMALL',
      name: 'Small Test Room',
      capacity: 20,
    }).expect(201);
    const big = (await get('/classrooms?minCapacity=50').expect(200)).body.map(
      (r: { code: string }) => r.code,
    );
    expect(big).toEqual(['R-101']);
  });

  it('deactivates rather than deletes, with parent rules', async () => {
    const { campus, building, room } = await campusBuildingRoom();
    expect((await patch(`/buildings/${building.id}`, { isActive: false }).expect(409)).body.code).toBe(
      'HAS_ACTIVE_CHILDREN',
    );
    await patch(`/classrooms/${room.id}`, { isActive: false }).expect(200);
    await patch(`/buildings/${building.id}`, { isActive: false }).expect(200);
    await patch(`/campuses/${campus.id}`, { isActive: false }).expect(200);
    expect(
      (await post('/buildings', { campusId: campus.id, code: 'NB', name: 'New Building' }).expect(400)).body
        .code,
    ).toBe('PARENT_INACTIVE');
    expect((await get('/classrooms').expect(200)).body).toHaveLength(0);
    expect((await get('/classrooms?includeInactive=true').expect(200)).body).toHaveLength(1);
  });
});

describe('who may see and change places', () => {
  it('lets every timetable reader see rooms, but only managers change them', async () => {
    await campusBuildingRoom();
    for (const role of ['STUDENT', 'LECTURER', 'REGISTRAR'] as const) {
      const { auth } = await signInAs(app, prisma, `${role.toLowerCase()}@example.test`, [role]);
      expect((await get('/classrooms', auth).expect(200)).body).toHaveLength(1);
      await post('/campuses', { code: 'NOPE', name: 'Not Allowed' }, auth).expect(403);
    }
  });

  it('requires university-wide scope to change places', async () => {
    const { auth } = await signInAs(app, prisma, 'fac.admin@example.test', ['UNIVERSITY_ADMIN'], {
      scope: { type: 'FACULTY', id: '01960000-0000-7000-8000-00000000000f' },
    });
    const res = await post('/campuses', { code: 'SCOPED', name: 'Scoped Attempt' }, auth).expect(403);
    expect(res.body.code).toBe('INSTITUTION_SCOPE_REQUIRED');
  });
});
