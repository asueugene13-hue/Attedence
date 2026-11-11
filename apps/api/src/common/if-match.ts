import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The version a change is based on, from the If-Match header, so a change made over someone else's
 * newer edit is refused instead of silently overwriting it.
 */
export function expectedVersion(req: Request, what = 'record'): number {
  const header = req.headers['if-match'];
  const value = typeof header === 'string' ? Number(header.replace(/"/g, '')) : NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException({
      code: 'VERSION_REQUIRED',
      message: `Send the If-Match header with the ${what} version you are changing.`,
    });
  }
  return value;
}
