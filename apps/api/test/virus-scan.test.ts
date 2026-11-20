import { createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { parseReply } from '../src/infrastructure/storage/virus-scanner.js';
import { FilesService } from '../src/modules/files/files.service.js';
import { createUser, resetDatabase, resetRedis } from './fixtures.js';

// Uploaded files are checked by ClamAV before they are stored (limitation 31). A stand-in clamd speaks
// the real INSTREAM protocol: length-prefixed chunks, a zero length to finish, one answer.
const FAKE_SIGNATURE = 'Test-Harmful-File (fake)';
const HARMFUL = Buffer.from('TEST-HARMFUL-CONTENT (fake)');
let mode: 'answer' | 'garbage' = 'answer';
let received: Buffer[] = [];

function fakeClamd(): Server {
  return createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let headerSeen = false;
    const body: Buffer[] = [];
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!headerSeen) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        if (buffer.subarray(0, end).toString() !== 'zINSTREAM') return void socket.end('UNKNOWN COMMAND\0');
        headerSeen = true;
        buffer = buffer.subarray(end + 1);
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const file = Buffer.concat(body);
          received.push(file);
          if (mode === 'garbage') return void socket.end('something odd\0');
          return void socket.end(
            file.includes(HARMFUL) ? `stream: ${FAKE_SIGNATURE} FOUND\0` : 'stream: OK\0',
          );
        }
        if (buffer.length < 4 + size) return;
        body.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
}

let app: INestApplication;
let prisma: PrismaService;
let files: FilesService;
let clamd: Server;
let uploaderId: string;

beforeAll(async () => {
  clamd = fakeClamd();
  await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', resolve));
  const address = clamd.address();
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(typeof address === 'object' && address ? address.port : 0);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  prisma = app.get(PrismaService);
  files = app.get(FilesService);
});

afterAll(async () => {
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
  await app.close();
  await new Promise((resolve) => clamd.close(resolve));
});

beforeEach(async () => {
  await resetDatabase(prisma);
  await resetRedis(app.get(RedisService));
  mode = 'answer';
  received = [];
  uploaderId = (await createUser(prisma, { email: 'uploader@example.test', roles: ['REGISTRAR'] })).id;
});

const store = (bytes: Buffer, purpose: 'IMPORT_FILE' | 'EXPORT_FILE' = 'IMPORT_FILE') =>
  files.store({ purpose, bytes, mimeType: 'text/csv', uploadedById: uploaderId });

/** The error's HTTP status and body, as the client would see them. */
async function refusal(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as { getStatus(): number; getResponse(): object } | null;
  expect(error).not.toBeNull();
  return { status: error!.getStatus(), body: error!.getResponse() };
}

describe('virus scanning of uploads', () => {
  it('stores a clean file after the scanner has seen all of it, even across several chunks', async () => {
    const big = Buffer.alloc(200 * 1024, 'a'); // more than three 64 KB chunks
    const stored = await store(big);
    expect(stored.sizeBytes).toBe(big.length);
    expect(received).toHaveLength(1);
    expect(received[0]!.equals(big)).toBe(true);
  });

  it('refuses a harmful file, stores nothing, and reports it on system health', async () => {
    const { status, body } = await refusal(store(Buffer.concat([Buffer.from('name\n'), HARMFUL])));
    expect(status).toBe(422);
    expect(body).toMatchObject({ code: 'FILE_INFECTED' });
    expect(await prisma.fileObject.count()).toBe(0);
    const event = await prisma.systemEvent.findFirstOrThrow({ where: { type: 'virus_scan.infected' } });
    expect(event).toMatchObject({ severity: 'HIGH', source: 'files' });
    expect(event.message).toContain(FAKE_SIGNATURE);
  });

  it('refuses the upload when the scanner gives no clear answer, rather than letting it through', async () => {
    mode = 'garbage';
    const { status, body } = await refusal(store(Buffer.from('a,b\n1,2\n')));
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'VIRUS_SCAN_UNAVAILABLE' });
    expect(await prisma.fileObject.count()).toBe(0);
    expect(await prisma.systemEvent.count({ where: { type: 'virus_scan.unavailable' } })).toBe(1);
  });

  it('does not scan report files AttendSure made itself', async () => {
    await store(Buffer.from('a,b\n'), 'EXPORT_FILE');
    expect(received).toHaveLength(0);
  });
});

describe('reading clamd answers', () => {
  it('understands OK and FOUND, and rejects anything else', () => {
    expect(parseReply('stream: OK\0')).toEqual({ status: 'CLEAN' });
    expect(parseReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      status: 'INFECTED',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(() => parseReply('INSTREAM size limit exceeded. ERROR\0')).toThrow(/unexpected answer/);
    expect(() => parseReply('')).toThrow(/unexpected answer/);
  });
});
