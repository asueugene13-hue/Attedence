import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FilePurpose, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';

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
  ) {}

  /**
   * Uploads the bytes first, then records them. If recording fails, the uploaded bytes are deleted again
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
