import { createHash, randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FilePurpose, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { SystemEventsService } from '../../infrastructure/jobs/system-events.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';
import { VirusScanner } from '../../infrastructure/storage/virus-scanner.js';

type Tx = Prisma.TransactionClient;

/**
 * Stored files. The bytes live in private object storage; this table records what each file is, who
 * uploaded it and its checksum. Other modules hold a file's id, never its storage key.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scanner: VirusScanner,
    private readonly systemEvents: SystemEventsService,
  ) {}

  /**
   * Checks an uploaded file for viruses (files AttendSure makes itself, report exports, are not), then
   * uploads the bytes, then records them. If recording fails, the uploaded bytes are deleted again
   * so storage never holds a file nobody knows about.
   */
  async store(
    input: {
      purpose: FilePurpose;
      bytes: Buffer;
      mimeType: string;
      originalName?: string;
      uploadedById: string;
    },
    tx: Tx = this.prisma,
  ) {
    if (input.purpose !== 'EXPORT_FILE') await this.scan(input);
    const key = `${input.purpose.toLowerCase().replace('_', '-')}/${randomUUID()}`;
    await this.storage.put(key, input.bytes, input.mimeType);
    try {
      return await tx.fileObject.create({
        data: {
          bucket: this.storage.bucket,
          key,
          purpose: input.purpose,
          mimeType: input.mimeType,
          sizeBytes: input.bytes.length,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
          originalName: input.originalName?.slice(0, 255),
          uploadedById: input.uploadedById,
        },
      });
    } catch (error) {
      await this.deleteBytes(key);
      throw error;
    }
  }

  /** A harmful file is refused and reported; if the scanner cannot be reached, nothing is stored. */
  private async scan(input: { purpose: FilePurpose; bytes: Buffer; uploadedById: string }) {
    let result;
    try {
      result = await this.scanner.scan(input.bytes);
    } catch (error) {
      await this.systemEvents.raise({
        type: 'virus_scan.unavailable',
        severity: 'HIGH',
        source: 'files',
        message: `An upload was refused because the virus scanner could not check it: ${(error as Error).message}`,
        data: { purpose: input.purpose, uploadedById: input.uploadedById },
      });
      throw new ServiceUnavailableException({
        code: 'VIRUS_SCAN_UNAVAILABLE',
        message:
          'The file could not be checked for viruses just now, so it was not saved. Try again in a few minutes.',
      });
    }
    if (result.status !== 'INFECTED') return;
    await this.systemEvents.raise({
      type: 'virus_scan.infected',
      severity: 'HIGH',
      source: 'files',
      message: `An uploaded file was refused: the virus scanner found ${result.signature}.`,
      data: { purpose: input.purpose, uploadedById: input.uploadedById, signature: result.signature },
    });
    throw new UnprocessableEntityException({
      code: 'FILE_INFECTED',
      message: 'This file contains a virus or other harmful content, so it was not saved.',
    });
  }

  async read(fileId: string): Promise<Buffer> {
    const file = await this.findStored(fileId);
    return this.storage.get(file.key);
  }

  async downloadLink(fileId: string) {
    const file = await this.findStored(fileId);
    return {
      ...(await this.storage.downloadUrl(file.key)),
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    };
  }

  /** Marks a file removed inside the caller's transaction; returns its key so the bytes can be deleted after commit. */
  async markRemoved(fileId: string, tx: Tx): Promise<string> {
    const file = await tx.fileObject.update({
      where: { id: fileId },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    return file.key;
  }

  /** Undoes `store` when the change that needed the file did not go through. */
  async discard(file: { id: string; key: string }): Promise<void> {
    await this.markRemoved(file.id, this.prisma);
    await this.deleteBytes(file.key);
  }

  /**
   * Deletes stored bytes. A failure is logged with the key, not thrown: the database already says the
   * file is removed, and the key lets an operator clean up by hand.
   */
  async deleteBytes(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.error(`Could not delete stored file ${key}: ${(error as Error).message}`);
    }
  }

  private async findStored(fileId: string) {
    const file = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!file || file.status !== 'STORED')
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such file.' });
    return file;
  }
}
