import { ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';

/** PostgreSQL error codes for rules the database enforces. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  exclusionViolation: '23P01',
} as const;

interface DbErrorInfo {
  pgCode: string | undefined;
  constraint: string | undefined;
}

interface AdapterCause {
  code?: string;
  originalCode?: string;
  originalMessage?: string;
  constraint?: { index?: string; fields?: string[] };
}

/**
 * Reads the PostgreSQL error code and constraint name from a Prisma error. With the pg driver adapter,
 * Prisma puts the database's own details in `meta.driverAdapterError.cause`:
 *  - unique violations (P2002): `originalCode` 23505 and `constraint.index` (the index name);
 *  - other rule violations (P2039 …): `code` such as 23P01 and the name inside `originalMessage`.
 */
export function dbErrorInfo(error: unknown): DbErrorInfo | null {
  // A rule checked when the transaction commits (a deferred constraint) surfaces as the driver
  // adapter's own error, not wrapped by Prisma, with the same details in `cause`.
  if (error instanceof Error && error.name === 'DriverAdapterError') {
    const cause = (error as Error & { cause?: AdapterCause }).cause;
    return {
      pgCode: cause?.originalCode ?? cause?.code,
      constraint: cause?.constraint?.index ?? cause?.originalMessage?.match(/constraint "([^"]+)"/)?.[1],
    };
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = error.meta as { target?: unknown; driverAdapterError?: { cause?: AdapterCause } } | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const constraint =
    cause?.constraint?.index ??
    cause?.originalMessage?.match(/constraint "([^"]+)"/)?.[1] ??
    (Array.isArray(meta?.target) ? meta.target.join(',') : undefined);
  const pgCode = error.code === 'P2002' ? PG.uniqueViolation : (cause?.code ?? cause?.originalCode);
  return { pgCode, constraint };
}

/**
 * Turns a database rule violation into a 409 with a clear message, or rethrows anything else.
 * `messages` maps a constraint name (or 'unique' for any duplicate) to what the person should be told.
 */
export function rethrowAsConflict(
  error: unknown,
  messages: Record<string, { code: string; message: string }>,
): never {
  const info = dbErrorInfo(error);
  if (info) {
    const specific = info.constraint ? messages[info.constraint] : undefined;
    const fallback = info.pgCode === PG.uniqueViolation ? messages.unique : undefined;
    const chosen = specific ?? fallback;
    if (chosen) throw new ConflictException(chosen);
  }
  throw error;
}
