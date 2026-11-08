import { BadRequestException, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

export interface UploadedBytes {
  buffer: Buffer;
  originalname: string;
}

/**
 * Accepts one file in a multipart form field, held in memory up to `maxBytes`. A larger file is refused
 * with 413 before it is fully read. Guards (sign-in, permissions) run first, so anonymous uploads never
 * reach this point.
 */
export const SingleFileUpload = (field: string, maxBytes: number) =>
  UseInterceptors(FileInterceptor(field, { limits: { fileSize: maxBytes, files: 1, fields: 10 } }));

export function requireFile(file: UploadedBytes | undefined, field: string): UploadedBytes {
  if (!file || file.buffer.length === 0) {
    throw new BadRequestException({
      code: 'FILE_REQUIRED',
      message: `Attach the file in the "${field}" form field.`,
    });
  }
  return file;
}

export const unsupportedFile = (allowed: string) =>
  new BadRequestException({
    code: 'UNSUPPORTED_FILE_TYPE',
    message: `That file is not ${allowed}. The type is checked from the file's contents, not its name.`,
  });
