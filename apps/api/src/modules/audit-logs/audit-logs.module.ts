import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller.js';

/** The audit-log search endpoint (API process only). */
@Module({
  controllers: [AuditLogsController],
})
export class AuditLogsModule {}
