import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { SETTING_KEYS, SETTINGS, type SettingKey, type SettingValue } from '@attendsure/shared';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';

/**
 * Institution settings. A value nobody has changed is the catalogue default (version 0). Changes are
 * version-checked, need a reason and are audited, and values are validated against the catalogue.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const row = await this.prisma.institutionSetting.findUnique({ where: { key } });
    if (!row) return SETTINGS[key].default as SettingValue<K>;
    const parsed = SETTINGS[key].schema.safeParse(row.value);
    // A stored value that no longer fits the catalogue falls back to the default rather than breaking monitoring.
    return (parsed.success ? parsed.data : SETTINGS[key].default) as SettingValue<K>;
  }

  async list() {
    const rows = await this.prisma.institutionSetting.findMany({
      include: { updatedBy: { select: { id: true, fullName: true } } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return SETTING_KEYS.map((key) => {
      const row = byKey.get(key);
      const def = SETTINGS[key];
      return {
        key,
        label: def.label,
        description: def.description,
        value: row?.value ?? def.default,
        default: def.default,
        isDefault: !row,
        version: row?.version ?? 0,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    });
  }

  async update(
    actor: AccessClaims,
    key: SettingKey,
    expectedVersion: number,
    rawValue: unknown,
    reason: string,
    context: RequestContext,
  ) {
    const parsed = SETTINGS[key].schema.safeParse(rawValue);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'That value is not allowed for this setting.',
        errors: parsed.error.issues.map((i) => ({ field: 'value', message: i.message })),
      });
    }
    const value = parsed.data as Prisma.InputJsonValue;
    await this.assertConsistent(key, parsed.data as number);

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.institutionSetting.findUnique({ where: { key } });
      const currentVersion = before?.version ?? 0;
      if (currentVersion !== expectedVersion) throw versionConflict(currentVersion);
      if (before) {
        const claimed = await tx.institutionSetting.updateMany({
          where: { key, version: expectedVersion },
          data: { value, version: { increment: 1 }, updatedById: actor.userId },
        });
        if (claimed.count !== 1) throw versionConflict(currentVersion);
      } else {
        await tx.institutionSetting.create({ data: { key, value, version: 1, updatedById: actor.userId } });
      }
      await this.audit.record(
        auditEntry(
          actor,
          'settings.changed',
          { type: 'setting', id: key },
          {
            before: { value: (before?.value ?? SETTINGS[key].default) as Prisma.InputJsonValue },
            after: { value },
            reason,
          },
          context,
        ),
        tx,
      );
    });
    return (await this.list()).find((s) => s.key === key)!;
  }

  /** Settings that depend on each other must stay sensible together. */
  private async assertConsistent(key: SettingKey, value: number) {
    const unconfirmed =
      key === 'monitoring.unconfirmedAfterMinutes'
        ? value
        : await this.get('monitoring.unconfirmedAfterMinutes');
    const review =
      key === 'monitoring.reviewAfterMinutes' ? value : await this.get('monitoring.reviewAfterMinutes');
    if (review <= unconfirmed) {
      throw new BadRequestException({
        code: 'INCONSISTENT_SETTINGS',
        message: `The review time (${review} min) must be later than the unconfirmed time (${unconfirmed} min).`,
      });
    }
  }
}

const versionConflict = (current: number) =>
  new ConflictException({
    code: 'VERSION_CONFLICT',
    message: 'Someone else changed this setting since you opened it. Reload it and try again.',
    errors: { currentVersion: current },
  });
