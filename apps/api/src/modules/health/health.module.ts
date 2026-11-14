import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import { RedisHealthIndicator } from './redis.health.js';

@Module({
  imports: [TerminusModule, SettingsModule],
  controllers: [HealthController, MetricsController],
  providers: [RedisHealthIndicator, MetricsService],
})
export class HealthModule {}
