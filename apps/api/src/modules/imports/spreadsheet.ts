import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';

export type SheetFormat = 'csv' | 'xlsx';

export interface SheetRow {
  /** As the person sees it in their spreadsheet: the header is row 1. */
  rowNumber: number;
  values: Record<string, string>;
}

export class SpreadsheetError extends Error {}

/**
 * Reads the first sheet into rows keyed by header name. Header names are compared in lower case with
 * spaces turned into underscores, so "Student Number" matches `student_number`. Blank rows are skipped.
 */
export async function readRows(
  bytes: Buffer,
  format: SheetFormat,
): Promise<{ headers: string[]; rows: SheetRow[] }> {
  const grid = format === 'csv' ? readCsv(bytes) : await readXlsx(bytes);
  const [header, ...body] = grid;
  if (!header || header.every((cell) => cell === ''))
    throw new SpreadsheetError('The file has no header row.');
  const headers = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows: SheetRow[] = [];
  body.forEach((cells, index) => {
    if (cells.every((cell) => cell.trim() === '')) return;
    const values: Record<string, string> = {};
    headers.forEach((name, column) => {
      if (name) values[name] = unescapeCell(cells[column] ?? '');
    });
    rows.push({ rowNumber: index + 2, values });
  });
  return { headers, rows };
}

function readCsv(bytes: Buffer): string[][] {
  try {
    return parse(bytes, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][];
  } catch (error) {
    throw new SpreadsheetError(`The CSV file could not be read: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

async function readXlsx(bytes: Buffer): Promise<string[][]> {
  let data;
  try {
    data = await readSheet(bytes);
  } catch (error) {
    throw new SpreadsheetError(`The Excel file could not be read: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const header = (data[0] ?? []).map((cell) => cellText(cell, ''));
  return data.map((row, r) =>
    row.map((cell, c) => (r === 0 ? cellText(cell, '') : cellText(cell, header[c] ?? ''))),
  );
}

/**
 * Excel stores a typed phone number as a number, which drops the leading 0 (0244… becomes 244…) or
 * the + (+233… becomes 233…). For the phone column only, those two exact shapes are put back.
 */
function cellText(cell: unknown, column: string): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'number') {
    const digits = String(cell);
    if (column.trim().toLowerCase() === 'phone') {
      if (/^\d{9}$/.test(digits)) return `0${digits}`;
      if (/^233\d{9}$/.test(digits)) return `+${digits}`;
    }
    return digits;
  }
  return String(cell);
}

// Spreadsheet programs run a cell that starts with = + - @ as a formula. Files we produce prefix such
// cells with an apostrophe (the OWASP advice for "CSV injection"); reading a file back removes it again.
const FORMULA_START = /^[=+\-@\t\r]/;
const escapeCell = (value: string) => (FORMULA_START.test(value) ? `'${value}` : value);
const unescapeCell = (value: string) =>
  value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;

export async function writeRows(headers: string[], rows: string[][], format: SheetFormat): Promise<Buffer> {
  const safe = rows.map((row) => row.map(escapeCell));
  if (format === 'csv') return Buffer.from(stringify([headers, ...safe]), 'utf8');
  const data = [headers, ...safe].map((row, r) =>
    row.map((value) => ({ value, type: String, ...(r === 0 ? { fontWeight: 'bold' as const } : {}) })),
  );
  return writeXlsxFile(data, {
    sheet: 'Data',
    columns: headers.map(() => ({ width: 22 })),
    stickyRowsCount: 1,
  }).toBuffer();
}

export const SHEET_MIME: Record<SheetFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
