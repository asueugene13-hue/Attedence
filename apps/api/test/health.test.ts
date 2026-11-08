import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';

// A route that fails unexpectedly, to prove internal error details never reach the caller.
@Controller('test-only')
class FailingController {
  @Get('boom')
  boom(): never {
    throw new Error('database password is hunter2');
  }
}

@Module({ imports: [AppModule], controllers: [FailingController] })
class TestAppModule {}

async function createApp(redisOverride?: RedisService): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [TestAppModule] });
  if (redisOverride) builder.overrideProvider(RedisService).useValue(redisOverride);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

describe('API with real PostgreSQL and Redis', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live answers without touching dependencies', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports the database and Redis as up', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.details.database.status).toBe('up');
    expect(res.body.details.redis.status).toBe('up');
  });

  it('returns RFC 9457 problem details for an unknown route, with the request ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/no-such-route')
      .set('X-Request-Id', 'test-request-0001')
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['x-request-id']).toBe('test-request-0001');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND', requestId: 'test-request-0001' });
  });

  it('replaces an unsafe incoming request ID with a generated one', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').set('X-Request-Id', '<script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('hides internal details of unexpected errors', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test-only/boom').expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body.requestId).toBeTruthy();
  });

  it('does not advertise the framework', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('readiness when Redis is unreachable', () => {
  let app: INestApplication;
  let deadRedis: Redis;

  beforeAll(async () => {
    // Port 1 has nothing listening; fail immediately instead of retrying.
    deadRedis = new Redis({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    deadRedis.on('error', () => undefined);
    const fake = {
      client: deadRedis,
      onModuleDestroy: async () => deadRedis.disconnect(),
    } as unknown as RedisService;
    app = await createApp(fake);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/ready returns 503 and names Redis as down', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.errors.redis.status).toBe('down');
    expect(res.body.errors.database.status).toBe('up');
  });
});
