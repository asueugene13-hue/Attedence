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

/**
 * Reads the PostgreSQL error code and constraint name from a Prisma error. Prisma reports unique
 * violations as P2002; other database rule violations arrive through the driver adapter's cause.
 */
export function dbErrorInfo(error: unknown): DbErrorInfo | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === 'P2002') {
    const target = (error.meta as { target?: unknown } | undefined)?.target;
    return {
      pgCode: PG.uniqueViolation,
      constraint: Array.isArray(target) ? target.join(',') : String(target ?? ''),
    };
  }
  const cause = (
    error.meta as { driverAdapterError?: { cause?: { code?: string; originalMessage?: string } } }
  )?.driverAdapterError?.cause;
  const constraint = cause?.originalMessage?.match(/constraint "([^"]+)"/)?.[1];
  return { pgCode: cause?.code, constraint };
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
