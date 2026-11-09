import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { IMPORT_LIMITS, type ImportListQuerySchema, type ImportRowsQuerySchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import { type UploadedBytes, unsupportedFile } from '../../common/upload.js';
import { type ImportBatch, type ImportRowStatus, Prisma } from '../../generated/prisma/client.js';
import { type JobContext, JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { detectFileType } from '../files/file-type.js';
import { FilesService } from '../files/files.service.js';
import { StudentImportService } from '../students/student-import.service.js';
import { type CheckedRow, checkHeaders, type ImportHandler, REPORT_COLUMNS } from './import-handler.js';
import { readRows, type SheetFormat, SpreadsheetError, writeRows } from './spreadsheet.js';

const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such import.' });
const invalidFile = (code: string, message: string, errors?: unknown) =>
  new BadRequestException({ code, message, ...(errors ? { errors } : {}) });

/** A large confirmed import runs in one transaction, so it gets more time than Prisma's 5-second default. */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

const headersOf = (handler: ImportHandler) => handler.columns.map((c) => c.key);

/**
 * The shared import pipeline: upload → automatic check → preview → a person confirms or cancels.
 * Nothing reaches the real records until confirmation, and confirmation saves all valid rows or none.
 * Each import type (students, enrolments) supplies its rules through an ImportHandler, and every
 * operation is given the handler for the URL it came through, so one type can never act on another's batch.
 */
@Injectable()
export class ImportsService implements OnModuleInit {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobRegistry,
    private readonly studentImport: StudentImportService,
  ) {}

  /** Activation emails for imported students are background jobs: one per row, retried on failure. */
  onModuleInit(): void {
    this.jobs.define<{ importRowId: string }>({
      queue: 'email',
      name: 'student-activation',
      attempts: 5,
      handle: (data, context) => this.sendActivationForRow(data.importRowId, context),
    });
  }

  template(handler: ImportHandler, format: SheetFormat) {
    return writeRows(headersOf(handler), [], format);
  }

  async upload(handler: ImportHandler, actor: AccessClaims, upload: UploadedBytes, context: RequestContext) {
    const type = detectFileType(upload.buffer);
    const format: SheetFormat | null =
      type === 'text/csv' ? 'csv' : type?.includes('spreadsheetml') ? 'xlsx' : null;
    if (!format || !type) throw unsupportedFile('a CSV or Excel (.xlsx) file');

    let sheet;
    try {
      sheet = await readRows(upload.buffer, format);
    } catch (error) {
      if (error instanceof SpreadsheetError) throw invalidFile('UNREADABLE_FILE', error.message);
      throw error;
    }
    const { missing, unknown } = checkHeaders(handler.columns, sheet.headers);
    if (missing.length > 0 || unknown.length > 0) {
      throw invalidFile(
        'COLUMNS_DO_NOT_MATCH',
        'The columns do not match the template. Download the template and keep its header row.',
        { missing, unknown },
      );
    }
    if (sheet.rows.length === 0)
      throw invalidFile('EMPTY_FILE', 'The file has a header row but no data rows.');
    if (sheet.rows.length > IMPORT_LIMITS.maxRows) {
      throw invalidFile(
        'TOO_MANY_ROWS',
        `One import can hold at most ${IMPORT_LIMITS.maxRows} rows. Split the file.`,
      );
    }

    const checked = await handler.check(sheet.rows);
    const rawByRow = new Map(sheet.rows.map((r) => [r.rowNumber, r.values]));
    const stored = await this.files.store({
      purpose: 'IMPORT_FILE',
      bytes: upload.buffer,
      mimeType: type,
      originalName: upload.originalname,
      uploadedById: actor.userId,
    });
    try {
      const batch = await this.prisma.$transaction(async (tx) => {
        const created = await tx.importBatch.create({
          data: {
            type: handler.type,
            format: format === 'csv' ? 'CSV' : 'XLSX',
            fileId: stored.id,
            uploadedById: actor.userId,
            ...counts(checked),
          },
        });
        await tx.importRow.createMany({
          data: checked.map((row) => ({
            batchId: created.id,
            rowNumber: row.rowNumber,
            raw: rawByRow.get(row.rowNumber) ?? {},
            ...rowFields(row),
          })),
        });
        await this.audit.record(
          auditEntry(
            actor,
            'imports.uploaded',
            { type: 'import', id: created.id },
            { after: { fileName: upload.originalname, ...counts(checked) } },
            context,
          ),
          tx,
        );
        return created;
      });
      return this.get(handler, batch.id);
    } catch (error) {
      await this.files.discard(stored);
      throw error;
    }
  }

  async list(handler: ImportHandler, query: z.output<typeof ImportListQuerySchema>) {
    const rows = await this.prisma.importBatch.findMany({
      where: {
        type: handler.type,
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: {
        file: { select: { originalName: true } },
        uploadedBy: { select: { id: true, fullName: true } },
      },
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((b) => this.view(b, b.file.originalName, b.uploadedBy)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(handler: ImportHandler, id: string) {
    const batch = await this.prisma.importBatch.findUnique({
      where: { id, type: handler.type },
      include: {
        file: { select: { originalName: true } },
        uploadedBy: { select: { id: true, fullName: true } },
      },
    });
    if (!batch) throw notFound();
    const emails = await this.prisma.importRow.groupBy({
      by: ['emailStatus'],
      where: { batchId: id, emailStatus: { not: null } },
      _count: true,
    });
    const email = (s: 'PENDING' | 'SENT' | 'FAILED') => emails.find((e) => e.emailStatus === s)?._count ?? 0;
    return {
      ...this.view(batch, batch.file.originalName, batch.uploadedBy),
      activationEmails: { pending: email('PENDING'), sent: email('SENT'), failed: email('FAILED') },
    };
  }

  async rows(handler: ImportHandler, id: string, query: z.output<typeof ImportRowsQuerySchema>) {
    await this.findBatch(handler, id);
    const rows = await this.prisma.importRow.findMany({
      where: {
        batchId: id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.after ? { rowNumber: { gt: query.after } } : {}),
      },
      orderBy: { rowNumber: 'asc' },
      take: query.limit + 1,
      select: {
        rowNumber: true,
        status: true,
        raw: true,
        errors: true,
        createdEntityId: true,
        emailStatus: true,
      },
    });
    const page = rows.slice(0, query.limit);
    return { data: page, nextAfter: rows.length > query.limit ? (page.at(-1)?.rowNumber ?? null) : null };
  }

  /**
   * Re-checks every row against the records as they are now (someone may have registered a student since
   * the upload), then saves the valid ones in one transaction. Rows that became duplicates are skipped and
   * shown as such; if anything fails, nothing is saved and the batch can be confirmed again.
   */
  async confirm(handler: ImportHandler, actor: AccessClaims, id: string, context: RequestContext) {
    await this.findBatch(handler, id);
    const claimed = await this.prisma.importBatch.updateMany({
      where: { id, status: 'VALIDATED' },
      data: { status: 'IMPORTING', decidedById: actor.userId, decidedAt: new Date() },
    });
    if (claimed.count !== 1) throw notPending();

    try {
      const stored = await this.prisma.importRow.findMany({
        where: { batchId: id },
        orderBy: { rowNumber: 'asc' },
      });
      const checked = await handler.check(
        stored.map((r) => ({ rowNumber: r.rowNumber, values: r.raw as Record<string, string> })),
      );
      await this.prisma.$transaction(
        async (tx) => {
          const valid = checked.filter((r) => r.status === 'VALID' && r.normalized);
          const created = await handler.importRows(
            tx,
            actor,
            valid.map((r) => ({ rowNumber: r.rowNumber, input: r.normalized })),
            id,
            context,
          );
          const createdByRow = new Map(created.map((c) => [c.rowNumber, c]));
          for (const row of checked) {
            const made = createdByRow.get(row.rowNumber);
            const saved = await tx.importRow.update({
              where: { batchId_rowNumber: { batchId: id, rowNumber: row.rowNumber } },
              data: made
                ? {
                    ...rowFields(row),
                    status: 'IMPORTED',
                    createdEntityId: made.entityId,
                    emailStatus: made.needsActivationEmail ? 'PENDING' : null,
                  }
                : rowFields(row),
            });
            // Queued with the import itself: if the import rolls back, no email is ever sent.
            if (made?.needsActivationEmail) {
              await this.outbox.add(tx, 'email', 'student-activation', { importRowId: saved.id });
            }
          }
          const totals = counts(checked);
          await tx.importBatch.update({
            where: { id },
            data: { ...totals, importedRows: created.length, status: 'COMPLETED', completedAt: new Date() },
          });
          await this.audit.record(
            auditEntry(
              actor,
              'imports.confirmed',
              { type: 'import', id },
              { after: { ...totals, importedRows: created.length } },
              context,
            ),
            tx,
          );
        },
        { timeout: CONFIRM_TIMEOUT_MS, maxWait: 10_000 },
      );
    } catch (error) {
      await this.prisma.importBatch.update({
        where: { id },
        data: { status: 'VALIDATED', decidedById: null, decidedAt: null },
      });
      this.logger.error(`Import ${id} could not be confirmed: ${(error as Error).message}`);
      throw error;
    }
    return this.get(handler, id);
  }

  /** Discards a checked file. Its stored copy is deleted; the row check results are kept as a record. */
  async cancel(handler: ImportHandler, actor: AccessClaims, id: string, context: RequestContext) {
    const batch = await this.findBatch(handler, id);
    const key = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.importBatch.updateMany({
        where: { id, status: 'VALIDATED' },
        data: { status: 'CANCELLED', decidedById: actor.userId, decidedAt: new Date() },
      });
      if (claimed.count !== 1) throw notPending();
      const removedKey = await this.files.markRemoved(batch.fileId, tx);
      await this.audit.record(
        auditEntry(
          actor,
          'imports.cancelled',
          { type: 'import', id },
          { after: { status: 'CANCELLED' } },
          context,
        ),
        tx,
      );
      return removedKey;
    });
    await this.files.deleteBytes(key);
    return this.get(handler, id);
  }

  /** Rows that were not imported, with the problems in a last column, ready to fix and upload again. */
  async errorReport(handler: ImportHandler, id: string, format: SheetFormat) {
    await this.findBatch(handler, id);
    const rows = await this.prisma.importRow.findMany({
      where: {
        batchId: id,
        status: { in: ['INVALID', 'DUPLICATE_IN_FILE', 'DUPLICATE_EXISTING'] satisfies ImportRowStatus[] },
      },
      orderBy: { rowNumber: 'asc' },
    });
    const template = headersOf(handler);
    const headers = [...template, ...REPORT_COLUMNS];
    const lines = rows.map((row) => {
      const raw = row.raw as Record<string, string>;
      const problems = ((row.errors as { message: string }[] | null) ?? []).map((e) => e.message).join('; ');
      return [...template.map((h) => raw[h] ?? ''), String(row.rowNumber), problems];
    });
    return writeRows(headers, lines, format);
  }

  /** Sends (again) activation emails still pending or failed, for example after a mail outage. */
  async retryActivationEmails(
    handler: ImportHandler,
    actor: AccessClaims,
    id: string,
    context: RequestContext,
  ) {
    const batch = await this.findBatch(handler, id);
    if (!handler.sendActivation) {
      throw new ConflictException({
        code: 'NO_ACTIVATION_EMAILS',
        message: 'This kind of import sends no emails.',
      });
    }
    if (batch.status !== 'COMPLETED') throw notPending('Only a completed import has activation emails.');
    const retried = await this.prisma.$transaction(async (tx) => {
      const failed = await tx.importRow.findMany({
        where: { batchId: id, emailStatus: 'FAILED' },
        select: { id: true },
      });
      for (const row of failed) {
        const claimed = await tx.importRow.updateMany({
          where: { id: row.id, emailStatus: 'FAILED' },
          data: { emailStatus: 'PENDING' },
        });
        if (claimed.count === 1)
          await this.outbox.add(tx, 'email', 'student-activation', { importRowId: row.id });
      }
      await this.audit.record(
        auditEntry(
          actor,
          'imports.activation_emails_retried',
          { type: 'import', id },
          { after: { retried: failed.length } },
          context,
        ),
        tx,
      );
      return failed.length;
    });
    this.logger.log(`Re-queued ${retried} activation emails for import ${id}.`);
    return this.get(handler, id);
  }

  /**
   * The background job for one imported student. A row already SENT is left alone (a job may run
   * twice after a crash). A failure is retried; after the last try the row is marked FAILED so staff
   * see it and can send it again. A mail problem never undoes the import.
   */
  private async sendActivationForRow(importRowId: string, context: JobContext): Promise<void> {
    const row = await this.prisma.importRow.findUnique({ where: { id: importRowId } });
    if (!row || row.emailStatus !== 'PENDING' || !row.createdEntityId) return;
    try {
      await this.studentImport.sendActivation(row.createdEntityId);
    } catch (error) {
      if (context.isFinalAttempt) {
        await this.prisma.importRow.update({ where: { id: importRowId }, data: { emailStatus: 'FAILED' } });
      }
      throw error;
    }
    await this.prisma.importRow.update({ where: { id: importRowId }, data: { emailStatus: 'SENT' } });
  }

  /** A batch of this handler's type; another type's batch is treated as not found. */
  private async findBatch(handler: ImportHandler, id: string) {
    const batch = await this.prisma.importBatch.findUnique({ where: { id, type: handler.type } });
    if (!batch) throw notFound();
    return batch;
  }

  private view(batch: ImportBatch, fileName: string | null, uploadedBy: { id: string; fullName: string }) {
    return {
      id: batch.id,
      type: batch.type,
      format: batch.format,
      fileName,
      status: batch.status,
      totalRows: batch.totalRows,
      validRows: batch.validRows,
      invalidRows: batch.invalidRows,
      duplicateRows: batch.duplicateRows,
      importedRows: batch.importedRows,
      uploadedBy,
      decidedById: batch.decidedById,
      decidedAt: batch.decidedAt,
      completedAt: batch.completedAt,
      createdAt: batch.createdAt,
    };
  }
}

const notPending = (message = 'This import is no longer waiting for confirmation.') =>
  new ConflictException({ code: 'NOT_PENDING', message });

function counts(rows: CheckedRow[]) {
  const count = (...statuses: CheckedRow['status'][]) =>
    rows.filter((r) => statuses.includes(r.status)).length;
  return {
    totalRows: rows.length,
    validRows: count('VALID'),
    invalidRows: count('INVALID'),
    duplicateRows: count('DUPLICATE_IN_FILE', 'DUPLICATE_EXISTING'),
  };
}

function rowFields(row: CheckedRow) {
  return {
    status: row.status,
    // DbNull clears a value left from the upload-time check when the re-check finds no problem.
    normalized: row.normalized ? (row.normalized as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    errors: row.errors.length > 0 ? (row.errors as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
  };
}
