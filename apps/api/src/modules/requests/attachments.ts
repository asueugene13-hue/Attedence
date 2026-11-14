import { REQUEST_ATTACHMENT_LIMITS } from '@attendsure/shared';
import { unsupportedFile, type UploadedBytes } from '../../common/upload.js';
import { detectFileType } from '../files/file-type.js';

/**
 * A supporting file for a dispute or an excuse request: a PDF, JPEG or PNG, worked out from the file's
 * bytes (never its name). Returns the real type, or throws 400 UNSUPPORTED_FILE_TYPE.
 */
export function requestAttachmentType(upload: UploadedBytes): string {
  const type = detectFileType(upload.buffer);
  if (!type || !(REQUEST_ATTACHMENT_LIMITS.types as readonly string[]).includes(type)) {
    throw unsupportedFile('a PDF, JPEG or PNG file');
  }
  return type;
}
