import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { SystemHealthService } from './system-health.service.js';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, SystemHealthService],
  exports: [SettingsService],
})
export class SettingsModule {}
