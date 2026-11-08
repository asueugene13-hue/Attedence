import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates a request body against a shared Zod schema. Invalid input becomes a 400 problem-details
 * response listing each field and what is wrong with it (never echoing the submitted value).
 */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new BadRequestException({
    message: 'The request is not valid.',
    code: 'VALIDATION_FAILED',
    errors: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || null,
      message: issue.message,
    })),
  });
}
