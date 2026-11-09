import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Severity } from '../../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Raises events for the Super Admin's system-health view (for example a job that failed for good). */
@Injectable()
export class SystemEventsService {
  private readonly logger = new Logger(SystemEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async raise(input: {
    type: string;
    severity: Severity;
    source: string;
    message: string;
    data?: Prisma.InputJsonValue;
  }) {
    this.logger.warn(`[${input.severity}] ${input.source}: ${input.message}`);
    return this.prisma.systemEvent.create({ data: input });
  }
}
