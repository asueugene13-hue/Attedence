import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from '../../config/app-config.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Every request gets an ID: the caller's X-Request-Id if it looks safe, otherwise a new UUID.
 * The ID is returned in the response header and appears on every log line and error body,
 * so a problem a user reports can be traced in the logs.
 */
export function requestIdFor(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          genReqId: requestIdFor,
          // Structured JSON logs in production; readable lines on a developer's machine.
          transport: config.nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            censor: '[redacted]',
          },
          autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/health/') ?? false },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
