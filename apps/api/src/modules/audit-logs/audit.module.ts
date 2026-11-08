import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** The audit writer, available everywhere (API and worker). */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
