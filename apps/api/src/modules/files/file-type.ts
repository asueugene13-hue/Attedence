/**
 * Works out what a file really is from its first bytes ("magic numbers"), never from its name or the
 * type the browser claims. Only the types AttendSure accepts are recognised; anything else is null.
 */
export type DetectedType =
  | 'image/jpeg'
  | 'image/png'
  | 'text/csv'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);

export function detectFileType(buf: Buffer): DetectedType | null {
  if (buf.length === 0) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // An .xlsx file is a ZIP archive containing the workbook parts.
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) && buf.includes('[Content_Types].xml')) return XLSX_MIME;
  return isPlainText(buf) ? 'text/csv' : null;
}

/** Valid UTF-8 with no NUL bytes: a text file, not a binary renamed to .csv. */
function isPlainText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}
