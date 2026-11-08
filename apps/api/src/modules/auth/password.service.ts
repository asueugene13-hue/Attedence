import { BadRequestException, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { COMMON_PASSWORDS } from './common-passwords.js';

/** OWASP's recommended Argon2id settings: 19 MiB memory, 2 iterations, 1 thread. */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Problems with a proposed password, or an empty list if it is acceptable. Length is checked by the schema. */
export function passwordProblems(password: string, email: string): string[] {
  const problems: string[] = [];
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) problems.push('is too common; choose something less predictable');
  if (/^(.)\1+$/.test(password)) problems.push('cannot be one character repeated');
  const name = email.split('@')[0]?.toLowerCase() ?? '';
  if (name.length >= 4 && lower.includes(name)) problems.push('cannot contain your email name');
  return problems;
}

@Injectable()
export class PasswordService {
  /** Compared against when an account does not exist, so response time does not reveal which emails exist. */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string | null, password: string): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= argon2.hash('attendsure-timing-equaliser', ARGON2_OPTIONS);
      await argon2.verify(await this.dummyHash, password);
      return false;
    }
    return argon2.verify(hash, password);
  }

  assertAcceptable(password: string, email: string, field = 'password'): void {
    const problems = passwordProblems(password, email);
    if (problems.length === 0) return;
    throw new BadRequestException({
      message: 'The request is not valid.',
      code: 'VALIDATION_FAILED',
      errors: problems.map((message) => ({ field, message })),
    });
  }
}
