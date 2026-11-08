import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { ConfigModule } from './config/config.module.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { HealthModule } from './modules/health/health.module.js';

/** Shared infrastructure used by both the API and the worker process. */
export const INFRASTRUCTURE_MODULES = [ConfigModule, LoggingModule, PrismaModule, RedisModule];

@Module({
  imports: [...INFRASTRUCTURE_MODULES, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
