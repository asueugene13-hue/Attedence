import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { Public } from '../authorization/access.decorators.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisHealthIndicator } from './redis.health.js';

/**
 * - /health/live: the process is running. Used to restart a stuck container.
 * - /health/ready: the database and Redis answer. Used to decide whether to send traffic here.
 */
@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redisHealth: RedisHealthIndicator,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma, { timeout: 1500 }),
      () => this.redisHealth.isHealthy('redis'),
    ]);
  }
}
