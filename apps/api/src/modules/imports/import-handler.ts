import type { PermissionKey } from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import type { ImportType, Prisma } from '../../generated/prisma/client.js';
import type { AccessClaims } from '../auth/token.service.js';

export interface RowProblem {
  column: string | null;
  code: string;
  message: string;
}

export type CheckedStatus = 'VALID' | 'INVALID' | 'DUPLICATE_IN_FILE' | 'DUPLICATE_EXISTING';

/** One row after checking. `normalized` is what will be saved, present only for a valid row. */
export interface CheckedRow<T = unknown> {
  rowNumber: number;
  status: CheckedStatus;
  normalized: T | null;
  errors: RowProblem[];
}

export interface SheetValues {
  rowNumber: number;
  values: Record<string, string>;
}

/**
 * What each kind of import (students, enrolments) supplies to the shared pipeline:
 * upload → check → preview → confirm or cancel → error report.
 * The pipeline owns the batch and row records; each handler owns its own rules and records.
 */
export interface ImportHandler<T = unknown> {
  readonly type: ImportType;
  /** Used in URLs and file names, e.g. "students". */
  readonly slug: string;
  readonly permission: PermissionKey;
  readonly columns: readonly { key: string; required: boolean }[];
  /** Checks rows against current records. Writes nothing. */
  check(rows: SheetValues[]): Promise<CheckedRow<T>[]>;
  /** Saves checked VALID rows inside the confirming transaction. */
  importRows(
    tx: Prisma.TransactionClient,
    actor: AccessClaims,
    rows: { rowNumber: number; input: T }[],
    batchId: string,
    context: RequestContext,
  ): Promise<{ rowNumber: number; entityId: string; needsActivationEmail: boolean }[]>;
  /** Only for imports that create accounts. True when an email was sent. */
  sendActivation?(entityId: string): Promise<boolean>;
}

/** Columns a re-uploaded error report carries in addition to the template's. */
export const REPORT_COLUMNS = ['row_number', 'problems'] as const;

export function checkHeaders(columns: ImportHandler['columns'], headers: string[]) {
  const known = new Set<string>([...columns.map((c) => c.key), ...REPORT_COLUMNS]);
  return {
    missing: columns.filter((c) => c.required && !headers.includes(c.key)).map((c) => c.key),
    unknown: headers.filter((h) => h !== '' && !known.has(h)),
  };
}

/** Marks every valid row whose key appears more than once: it is unclear which copy is right. */
export function markDuplicatesInFile<T>(
  rows: CheckedRow<T>[],
  keyOf: (input: T) => string,
  column: string,
  label: string,
) {
  const seen = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.normalized) continue;
    const key = keyOf(row.normalized);
    seen.set(key, [...(seen.get(key) ?? []), row.rowNumber]);
  }
  for (const row of rows) {
    if (!row.normalized) continue;
    const others = (seen.get(keyOf(row.normalized)) ?? []).filter((n) => n !== row.rowNumber);
    if (others.length === 0) continue;
    row.status = 'DUPLICATE_IN_FILE';
    row.errors.push({
      column,
      code: 'DUPLICATE_IN_FILE',
      message: `Same ${label} as row ${others.join(', ')}.`,
    });
  }
}

/** Required-column blanks plus schema issues, one message per column. */
export function basicRowProblems(
  columns: ImportHandler['columns'],
  values: Record<string, string>,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): RowProblem[] {
  const problems: RowProblem[] = [];
  for (const column of columns) {
    if (column.required && (values[column.key] ?? '').trim() === '') {
      problems.push({ column: column.key, code: 'REQUIRED', message: `${column.key} is required` });
    }
  }
  for (const issue of issues) {
    const column = String(issue.path[0] ?? '');
    if (problems.some((p) => p.column === column)) continue;
    problems.push({ column, code: 'INVALID_VALUE', message: `${column} ${issue.message}` });
  }
  return problems;
}

export const problem = (column: string, code: string, message: string): RowProblem => ({
  column,
  code,
  message,
});

export const IMPORT_HANDLERS = Symbol('IMPORT_HANDLERS');
