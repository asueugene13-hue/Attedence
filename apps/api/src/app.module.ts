import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { ConfigModule } from './config/config.module.js';
import { CryptoModule } from './infrastructure/crypto/crypto.module.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';
import { MailModule } from './infrastructure/mail/mail.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { AuditModule } from './modules/audit-logs/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';

/** Shared infrastructure used by both the API and the worker process. */
export const INFRASTRUCTURE_MODULES = [
  ConfigModule,
  LoggingModule,
  PrismaModule,
  RedisModule,
  CryptoModule,
  MailModule,
  AuditModule,
];

@Module({
  imports: [...INFRASTRUCTURE_MODULES, HealthModule, AuthModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
