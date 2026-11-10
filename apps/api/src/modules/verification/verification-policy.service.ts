import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  DEFAULT_VERIFICATION_RULES,
  type TryDecisionSchema,
  type VerificationRules,
  VerificationRulesSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { decide } from './decision-engine.js';

export interface PolicyVersion {
  version: number;
  rules: VerificationRules;
  reason: string | null;
  createdBy: { id: string; fullName: string } | null;
  createdAt: Date | null;
}

const DEFAULTS: PolicyVersion = {
  version: 0,
  rules: DEFAULT_VERIFICATION_RULES,
  reason: 'Defaults (PRESENCE_VERIFICATION.md §9)',
  createdBy: null,
  createdAt: null,
};

/**
 * The verification policy (PRESENCE_VERIFICATION.md §9). Every change is a new version with a reason;
 * versions are never edited (a database trigger refuses it). Attendance sessions record the version
 * they used (Phase 5), so every decision can be explained later.
 */
@Injectable()
export class VerificationPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** The newest version, or the defaults (version 0) if none has been saved. */
  async current(): Promise<PolicyVersion> {
    const row = await this.prisma.verificationPolicy.findFirst({
      orderBy: { version: 'desc' },
      include: { createdBy: { select: { id: true, fullName: true } } },
    });
    return row ? this.view(row) : DEFAULTS;
  }

  async byVersion(version: number): Promise<PolicyVersion | null> {
    if (version === 0) return DEFAULTS;
    const row = await this.prisma.verificationPolicy.findUnique({
      where: { version },
      include: { createdBy: { select: { id: true, fullName: true } } },
    });
    return row ? this.view(row) : null;
  }

  async history() {
    const rows = await this.prisma.verificationPolicy.findMany({
      orderBy: { version: 'desc' },
      include: { createdBy: { select: { id: true, fullName: true } } },
    });
    return { data: [...rows.map((r) => this.view(r)), DEFAULTS] };
  }

  /**
   * Saves a new version. Turning the beacon requirement off needs a Super Admin (§9), because it
   * removes the main location evidence.
   */
  async create(actor: AccessClaims, rules: VerificationRules, reason: string, context: RequestContext) {
    const before = await this.current();
    if (!rules.bleRequired && before.rules.bleRequired && actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException({
        code: 'SUPER_ADMIN_REQUIRED',
        message: 'Only a Super Admin can turn off the beacon requirement.',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      // One new version at a time, so two saves cannot both become the same number.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('verification-policy'))`;
      const latest = await tx.verificationPolicy.findFirst({
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;
      const row = await tx.verificationPolicy.create({
        data: { version, rules, reason, createdById: actor.userId, createdAt: this.clock.now() },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'verification_policies.created',
          { type: 'verification_policy', id: row.id },
          { before: { version: before.version, rules: before.rules }, after: { version, rules }, reason },
          context,
        ),
        tx,
      );
    });
    return this.current();
  }

  /** What the current policy would decide for evidence entered by hand. Nothing is saved. */
  async tryCase(input: z.output<typeof TryDecisionSchema>) {
    const policy = await this.current();
    const decision = decide(
      {
        ...input,
        qr: 'VALID',
        sessionOpen: true,
        enrolled: true,
        accountActive: true,
        attemptsSoFar: 0,
      },
      policy.rules,
    );
    return { policyVersion: policy.version, ...decision };
  }

  private view(row: {
    version: number;
    rules: unknown;
    reason: string;
    createdAt: Date;
    createdBy: { id: string; fullName: string };
  }): PolicyVersion {
    // A stored version is read through the schema, so a rule added later takes its default.
    return {
      version: row.version,
      rules: VerificationRulesSchema.parse(row.rules),
      reason: row.reason,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }
}
