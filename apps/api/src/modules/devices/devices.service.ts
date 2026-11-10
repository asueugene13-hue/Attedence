import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DeviceListQuerySchema, RegisterDeviceSchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma, UserDevice } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { RiskFlagsService } from '../risk-flags/risk-flags.service.js';
import { StudentsService } from '../students/students.service.js';

const DAY = 86_400_000;
/** Another student signed in on the same phone this recently counts as switching accounts. */
const ACCOUNT_SWITCH_WINDOW_MS = DAY;
/** This many requests for a new attendance phone in this period is flagged as frequent switching. */
const DEVICE_SWITCH_LIMIT = 3;
const DEVICE_SWITCH_WINDOW_MS = 90 * DAY;

const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such phone.' });
const changed = () =>
  new ConflictException({
    code: 'DEVICE_CHANGED',
    message: 'This phone’s status changed a moment ago. Reload and try again.',
  });

/**
 * Trusted phones (PRESENCE_VERIFICATION.md §5, D-10). A student's first phone becomes their attendance
 * phone; any later phone waits until a Registrar or Administrator approves it, and then the old one is
 * REPLACED. Staff phones are trusted when registered but are never attendance phones. Phones shared
 * between students raise risk flags for a person to review; nothing is blocked automatically.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly flags: RiskFlagsService,
    private readonly students: StudentsService,
    private readonly access: AcademicAccessService,
    private readonly clock: Clock,
  ) {}

  /**
   * Registers the phone the app runs on, or recognises it again. The same installation with a
   * different key is refused: the app then starts over as a new phone, which needs approval.
   */
  async register(actor: AccessClaims, input: z.output<typeof RegisterDeviceSchema>, context: RequestContext) {
    const now = this.clock.now();
    const studentId = await this.students.idForUser(actor.userId);
    const device = await this.prisma.$transaction(async (tx) => {
      // One registration per person at a time, so two phones racing cannot both become "the first".
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'devices:' + actor.userId}))`;
      const existing = await tx.userDevice.findUnique({
        where: { userId_installationId: { userId: actor.userId, installationId: input.installationId } },
      });
      if (existing) {
        if (existing.publicKey !== input.publicKey) {
          throw new ConflictException({
            code: 'DEVICE_KEY_MISMATCH',
            message: 'This phone’s key has changed, so it is registered again as a new phone.',
          });
        }
        return tx.userDevice.update({
          where: { id: existing.id },
          data: {
            model: input.model,
            osVersion: input.osVersion,
            appVersion: input.appVersion,
            lastSeenAt: now,
          },
        });
      }

      const everTrusted = studentId
        ? (await tx.userDevice.count({ where: { userId: actor.userId, trustedAt: { not: null } } })) > 0
        : false;
      // Staff phones are trusted at once; a student's first phone becomes the attendance phone.
      const trustNow = !studentId || !everTrusted;
      const created = await tx.userDevice.create({
        data: {
          userId: actor.userId,
          installationId: input.installationId,
          platform: input.platform,
          model: input.model,
          osVersion: input.osVersion,
          appVersion: input.appVersion,
          publicKey: input.publicKey,
          status: trustNow ? 'TRUSTED' : 'PENDING_APPROVAL',
          isAttendanceDevice: Boolean(studentId) && trustNow,
          trustedAt: trustNow ? now : null,
          lastSeenAt: now,
          createdAt: now,
        },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'devices.registered',
          { type: 'device', id: created.id },
          {
            after: {
              ...this.view(created),
              rule: trustNow ? (studentId ? 'FIRST_PHONE' : 'STAFF') : 'NEEDS_APPROVAL',
            },
          },
          context,
        ),
        tx,
      );
      if (studentId) await this.flagSharing(tx, created, studentId, now);
      return created;
    });
    return this.view(device);
  }

  /** The caller's own phones. */
  async mine(userId: string) {
    const rows = await this.prisma.userDevice.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return { data: rows.map((d) => this.view(d)) };
  }

  /** A student asks to make this (pending) phone their attendance phone. */
  async requestTrust(actor: AccessClaims, deviceId: string, reason: string, context: RequestContext) {
    const device = await this.prisma.userDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== actor.userId) throw notFound();
    if (device.status !== 'PENDING_APPROVAL') {
      throw new ConflictException({
        code: 'NOT_PENDING',
        message: 'Only a phone waiting for approval can be requested.',
      });
    }
    const now = this.clock.now();
    const studentId = await this.students.idForUser(actor.userId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const done = await tx.userDevice.updateMany({
        where: { id: deviceId, status: 'PENDING_APPROVAL' },
        data: { trustRequestedAt: now, trustRequestReason: reason },
      });
      if (done.count !== 1) throw changed();
      await this.audit.record(
        auditEntry(actor, 'devices.trust_requested', { type: 'device', id: deviceId }, { reason }, context),
        tx,
      );
      const recent = await tx.userDevice.count({
        where: {
          userId: actor.userId,
          trustRequestedAt: { gte: new Date(now.getTime() - DEVICE_SWITCH_WINDOW_MS) },
        },
      });
      if (studentId && recent >= DEVICE_SWITCH_LIMIT) {
        await this.flags.raise(
          {
            type: 'DEVICE_SWITCH',
            severity: 'LOW',
            studentId,
            deviceId,
            evidence: { requestsIn90Days: recent },
            dedupeKey: `DEVICE_SWITCH:${studentId}`,
          },
          tx,
        );
      }
      return tx.userDevice.findUniqueOrThrow({ where: { id: deviceId } });
    });
    return this.view(updated);
  }

  /** Phones for approvers: by default, every phone waiting for a decision. */
  async list(actor: AccessClaims, query: z.output<typeof DeviceListQuerySchema>) {
    await this.access.assertInstitutionWide(actor);
    const rows = await this.prisma.userDevice.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.requested ? { status: 'PENDING_APPROVAL', trustRequestedAt: { not: null } } : {}),
        ...(query.q
          ? {
              user: {
                OR: [
                  { email: { contains: query.q, mode: 'insensitive' } },
                  { fullName: { contains: query.q, mode: 'insensitive' } },
                  { studentProfile: { studentNumber: { contains: query.q } } },
                ],
              },
            }
          : {}),
      },
      include: { user: { select: { id: true, fullName: true, email: true } } },
      orderBy: [{ trustRequestedAt: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const students = await this.students.byUserIds(rows.map((r) => r.userId));
    return {
      data: rows.map((r) => ({
        ...this.view(r),
        owner: { ...r.user, studentNumber: students.get(r.userId)?.studentNumber ?? null },
      })),
    };
  }

  /** Approves a student's new phone: it becomes the attendance phone and the old one is REPLACED. */
  async approve(actor: AccessClaims, id: string, note: string | undefined, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    const device = await this.find(id);
    if (device.status !== 'PENDING_APPROVAL') {
      throw new ConflictException({
        code: 'NOT_PENDING',
        message: 'Only a phone waiting for approval can be approved.',
      });
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.userDevice.findMany({
        where: { userId: device.userId, status: 'TRUSTED', isAttendanceDevice: true },
      });
      await tx.userDevice.updateMany({
        where: { id: { in: previous.map((p) => p.id) }, status: 'TRUSTED' },
        data: { status: 'REPLACED', isAttendanceDevice: false },
      });
      const done = await tx.userDevice.updateMany({
        where: { id, status: 'PENDING_APPROVAL' },
        data: { status: 'TRUSTED', isAttendanceDevice: true, trustedAt: now, approvedById: actor.userId },
      });
      if (done.count !== 1) throw changed();
      await this.audit.record(
        auditEntry(
          actor,
          'devices.approved',
          { type: 'device', id },
          {
            before: { status: 'PENDING_APPROVAL' },
            after: { status: 'TRUSTED', replaced: previous.map((p) => p.id) },
            reason: note,
          },
          context,
        ),
        tx,
      );
    });
    return this.view(await this.find(id));
  }

  /** Refuses a waiting phone, or revokes a trusted one (for example a lost phone). A reason is required. */
  async revoke(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    const device = await this.find(id);
    if (device.status !== 'PENDING_APPROVAL' && device.status !== 'TRUSTED') {
      throw new ConflictException({ code: 'ALREADY_INACTIVE', message: 'This phone is already out of use.' });
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.userDevice.updateMany({
        where: { id, status: device.status },
        data: {
          status: 'REVOKED',
          isAttendanceDevice: false,
          revokedAt: now,
          revokedById: actor.userId,
          revokeReason: reason,
        },
      });
      if (done.count !== 1) throw changed();
      await this.audit.record(
        auditEntry(
          actor,
          device.status === 'PENDING_APPROVAL' ? 'devices.refused' : 'devices.revoked',
          { type: 'device', id },
          { before: { status: device.status }, after: { status: 'REVOKED' }, reason },
          context,
        ),
        tx,
      );
    });
    return this.view(await this.find(id));
  }

  /** A signed-in person may not act on someone else's phone through the "me" routes. */
  assertOwn(actor: AccessClaims, device: UserDevice) {
    if (device.userId !== actor.userId) {
      throw new ForbiddenException({ code: 'NOT_YOUR_DEVICE', message: 'That is not your phone.' });
    }
  }

  /**
   * One phone, several students: a shared phone (SHARED_DEVICE), or a quick switch between accounts
   * (ACCOUNT_SWITCH) when the other student used it within a day. Flagged for review, never blocked.
   */
  private async flagSharing(tx: Prisma.TransactionClient, device: UserDevice, studentId: string, now: Date) {
    const others = await tx.userDevice.findMany({
      where: { installationId: device.installationId, userId: { not: device.userId } },
    });
    if (others.length === 0) return;
    const otherStudents = await this.students.byUserIds(others.map((o) => o.userId));
    const studentOthers = others.filter((o) => otherStudents.has(o.userId));
    if (studentOthers.length === 0) return;
    const recent = studentOthers.some(
      (o) => o.lastSeenAt && now.getTime() - o.lastSeenAt.getTime() < ACCOUNT_SWITCH_WINDOW_MS,
    );
    const type = recent ? 'ACCOUNT_SWITCH' : 'SHARED_DEVICE';
    const ids = [studentId, ...studentOthers.map((o) => otherStudents.get(o.userId)!.id)].sort();
    await this.flags.raise(
      {
        type,
        severity: 'MEDIUM',
        studentId,
        deviceId: device.id,
        evidence: {
          installationId: device.installationId,
          students: ids,
          otherAccountsLastSeen: studentOthers.map((o) => o.lastSeenAt?.toISOString() ?? null),
        },
        dedupeKey: `${type}:${device.installationId}:${ids.join(',')}`,
      },
      tx,
    );
  }

  private async find(id: string) {
    const device = await this.prisma.userDevice.findUnique({ where: { id } });
    if (!device) throw notFound();
    return device;
  }

  view(d: UserDevice) {
    return {
      id: d.id,
      installationId: d.installationId,
      platform: d.platform,
      model: d.model,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      status: d.status,
      isAttendanceDevice: d.isAttendanceDevice,
      trustedAt: d.trustedAt,
      trustRequestedAt: d.trustRequestedAt,
      trustRequestReason: d.trustRequestReason,
      revokedAt: d.revokedAt,
      revokeReason: d.revokeReason,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
    };
  }
}
