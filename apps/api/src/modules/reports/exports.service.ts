import {
  ForbiddenException,
  GoneException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type ExportRequest,
  REPORT_LABELS,
  RequestExportSchema,
  ROLE_LABELS,
  type RoleKey,
} from '@attendsure/shared';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import { AppConfig } from '../../config/app-config.js';
import type { ReportExport } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import type { JobContext } from '../../infrastructure/jobs/job-registry.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { ScopeService } from '../authorization/scope.service.js';
import { FilesService } from '../files/files.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { EXPORT_EXTENSION, EXPORT_MIME, render } from './render.js';
import { containsPersonalData, ReportBuilder } from './report-builder.js';

const DAY = 24 * 3_600_000;
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such report file.' });

/**
 * Report exports (Phase 7 step 2). Asking for a file checks the permissions at once and queues the
 * work; the worker builds it with the requester's own access (checked again, including that they still
 * hold the role), stores it privately and tells them. Files are deleted after the retention period
 * (`reports.exportRetentionDays`); the log stays. Requests, files made, failures, downloads and expiries
 * are all in the audit log.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly jobs: JobRegistry,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionService,
    private readonly scopes: ScopeService,
    private readonly builder: ReportBuilder,
  ) {}

  onModuleInit(): void {
    this.jobs.define<{ exportId: string }>({
      queue: 'system',
      name: 'report-export',
      attempts: 3,
      handle: (data, context) => this.make(data.exportId, context),
    });
    this.jobs.define({
      queue: 'system',
      name: 'report-exports-expire',
      attempts: 3,
      handle: async () => {
        await this.expire();
      },
    });
    this.jobs.every('system', 'report-exports-expire', 60 * 60_000);
  }

  async request(actor: AccessClaims, input: ExportRequest, context: RequestContext) {
    await this.builder.assertAllowed(actor, input);
    await this.builder.preflight(actor, input);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.reportExport.create({
        data: {
          requestedById: actor.userId,
          requestedRole: actor.role,
          reportType: input.reportType,
          params: input.params,
          format: input.format,
          containsPersonalData: containsPersonalData(input),
          title: REPORT_LABELS[input.reportType],
          createdAt: this.clock.now(),
        },
      });
      await this.outbox.add(tx, 'system', 'report-export', { exportId: created.id });
      await this.audit.record(
        auditEntry(
          actor,
          'reports.export_requested',
          { type: 'report_export', id: created.id },
          {
            after: {
              reportType: input.reportType,
              format: input.format,
              params: input.params,
              containsPersonalData: created.containsPersonalData,
            },
          },
          context,
        ),
        tx,
      );
      return created;
    });
    return this.view(row);
  }

  /** MINE (default): the caller's files. ALL: everyone's (the export log), for people who read the audit log. */
  async list(actor: AccessClaims, all: boolean) {
    if (all && !(await this.permissions.forRole(actor.role)).has('audit_logs.read')) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Only people who read the audit log see every export.',
      });
    }
    const rows = await this.prisma.reportExport.findMany({
      where: all ? {} : { requestedById: actor.userId },
      orderBy: { createdAt: 'desc' },
      take: all ? 500 : 100,
      include: { requestedBy: { select: { fullName: true } } },
    });
    return { data: rows.map((r) => ({ ...this.view(r), requestedBy: r.requestedBy.fullName })) };
  }

  async get(actor: AccessClaims, id: string) {
    return this.view(await this.own(actor, id));
  }

  /** A short-lived link to the file; every download is logged. */
  async download(actor: AccessClaims, id: string, context: RequestContext) {
    const row = await this.own(actor, id);
    const now = this.clock.now();
    if (row.status === 'EXPIRED' || (row.expiresAt && row.expiresAt <= now)) {
      throw new GoneException({
        code: 'EXPIRED',
        message: 'This file has been deleted after its retention period. Make it again.',
      });
    }
    if (row.status !== 'READY' || !row.fileId) {
      throw new NotFoundException({ code: 'NOT_READY', message: 'This file is not ready yet.' });
    }
    const link = await this.files.downloadLink(row.fileId);
    await this.prisma.$transaction(async (tx) => {
      await tx.reportExport.update({
        where: { id },
        data: { downloadCount: { increment: 1 }, lastDownloadedAt: now },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'reports.export_downloaded',
          { type: 'report_export', id },
          { after: { reportType: row.reportType, containsPersonalData: row.containsPersonalData } },
          context,
        ),
        tx,
      );
    });
    return { ...link, fileName: this.fileName(row) };
  }

  // ───────── The worker ─────────

  /** Builds and stores one file. Safe to retry: only a QUEUED export is picked up. */
  async make(exportId: string, job: JobContext = { attempt: 1, isFinalAttempt: true }): Promise<void> {
    const claimed = await this.prisma.reportExport.updateMany({
      where: { id: exportId, status: 'QUEUED' },
      data: { status: 'RUNNING' },
    });
    if (claimed.count !== 1) return;
    const row = await this.prisma.reportExport.findUniqueOrThrow({
      where: { id: exportId },
      include: { requestedBy: { select: { fullName: true } } },
    });
    const role = row.requestedRole as RoleKey;
    try {
      if (!(await this.scopes.holdsRole(row.requestedById, role))) {
        throw new ForbiddenException({
          code: 'ROLE_ENDED',
          message: 'You no longer hold the role this report was asked for in.',
        });
      }
      const actor: AccessClaims = { userId: row.requestedById, role, sessionId: '' };
      const request = RequestExportSchema.parse({
        reportType: row.reportType,
        format: row.format,
        params: row.params,
      });
      const report = await this.builder.build(actor, request);
      const now = this.clock.now();
      const when = new Intl.DateTimeFormat('en-GB', {
        timeZone: this.config.institutionTimezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(now);
      const bytes = await render(report, row.format, {
        generated: `Made ${when} for ${row.requestedBy.fullName} (${ROLE_LABELS[role]}) by AttendSure`,
        personal: row.containsPersonalData,
      });
      const stored = await this.files.store({
        purpose: 'EXPORT_FILE',
        bytes,
        mimeType: EXPORT_MIME[row.format],
        originalName: this.fileName(row),
        uploadedById: row.requestedById,
      });
      const days = await this.settings.get('reports.exportRetentionDays');
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.reportExport.update({
            where: { id: exportId },
            data: {
              status: 'READY',
              fileId: stored.id,
              rowCount: report.rows.length,
              title: report.title,
              completedAt: now,
              expiresAt: new Date(now.getTime() + days * DAY),
            },
          });
          await this.audit.record(
            {
              action: 'reports.export_ready',
              entityType: 'report_export',
              entityId: exportId,
              after: { rows: report.rows.length, sizeBytes: bytes.length, expiresInDays: days },
            },
            tx,
          );
        });
      } catch (error) {
        await this.files.discard(stored);
        throw error;
      }
      await this.notifications.notify({
        userIds: [row.requestedById],
        category: 'REPORT_READY',
        title: `Report ready: ${report.title}`,
        body: `Your ${row.format} file is ready to download for ${days} days.`,
        data: { path: '/reports' },
        related: { type: 'report_export', id: exportId },
        dedupeKey: `report-ready:${exportId}`,
      });
    } catch (error) {
      // A refusal (permission, scope, a missing section) is final; anything else is retried.
      const final = error instanceof HttpException || job.isFinalAttempt;
      if (!final) {
        await this.prisma.reportExport.update({ where: { id: exportId }, data: { status: 'QUEUED' } });
        throw error;
      }
      const message =
        error instanceof HttpException
          ? ((error.getResponse() as { message?: string }).message ?? error.message)
          : 'The file could not be made because of a technical problem. Try again later.';
      if (!(error instanceof HttpException))
        this.logger.error(`Report ${exportId} failed: ${(error as Error).message}`);
      await this.prisma.$transaction(async (tx) => {
        await tx.reportExport.update({
          where: { id: exportId },
          data: { status: 'FAILED', error: message, completedAt: this.clock.now() },
        });
        await this.audit.record(
          {
            action: 'reports.export_failed',
            entityType: 'report_export',
            entityId: exportId,
            after: { error: message },
          },
          tx,
        );
      });
      await this.notifications.notify({
        userIds: [row.requestedById],
        category: 'REPORT_FAILED',
        title: `Report not made: ${row.title ?? REPORT_LABELS[row.reportType]}`,
        body: message,
        data: { path: '/reports' },
        related: { type: 'report_export', id: exportId },
        dedupeKey: `report-failed:${exportId}`,
      });
    }
  }

  /** Deletes files past their retention period; the log entries stay (EXPIRED). Safe to re-run. */
  async expire(): Promise<{ expired: number }> {
    const due = await this.prisma.reportExport.findMany({
      where: { status: 'READY', expiresAt: { lte: this.clock.now() } },
      take: 500,
    });
    let expired = 0;
    for (const row of due) {
      let key: string | null = null;
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.reportExport.updateMany({
          where: { id: row.id, status: 'READY' },
          data: { status: 'EXPIRED' },
        });
        if (claimed.count !== 1) return;
        if (row.fileId) key = await this.files.markRemoved(row.fileId, tx);
        await this.audit.record(
          {
            action: 'reports.export_expired',
            entityType: 'report_export',
            entityId: row.id,
            after: { fileId: row.fileId },
          },
          tx,
        );
        expired++;
      });
      if (key) await this.files.deleteBytes(key);
    }
    return { expired };
  }

  // ───────── Helpers ─────────

  private async own(actor: AccessClaims, id: string): Promise<ReportExport> {
    const row = await this.prisma.reportExport.findUnique({ where: { id } });
    if (!row || row.requestedById !== actor.userId) throw notFound();
    return row;
  }

  private fileName(row: ReportExport) {
    const slug = (row.title ?? REPORT_LABELS[row.reportType])
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
    return `${slug || 'report'}.${EXPORT_EXTENSION[row.format]}`;
  }

  private view(r: ReportExport) {
    return {
      id: r.id,
      reportType: r.reportType,
      title: r.title,
      format: r.format,
      params: r.params,
      status: r.status,
      containsPersonalData: r.containsPersonalData,
      rowCount: r.rowCount,
      error: r.error,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      expiresAt: r.expiresAt,
      downloadCount: r.downloadCount,
    };
  }
}
