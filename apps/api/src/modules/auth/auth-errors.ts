import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

/** One message for wrong email, wrong password and locked accounts, so attackers learn nothing. */
export const invalidCredentials = () =>
  new UnauthorizedException({
    code: 'INVALID_CREDENTIALS',
    message:
      'The email or password is incorrect, or the account is temporarily locked after too many attempts. ' +
      'Try again later or reset your password.',
  });

export const signInAgain = () =>
  new UnauthorizedException({
    code: 'UNAUTHENTICATED',
    message: 'Your session has ended. Please sign in again.',
  });

export const accountInactive = () =>
  new ForbiddenException({
    code: 'ACCOUNT_INACTIVE',
    message: 'This account is not active. Contact the university administrator.',
  });

export const noRole = () =>
  new ForbiddenException({
    code: 'NO_ROLE',
    message: 'This account has no role in AttendSure yet. Contact the university administrator.',
  });

export const invalidLinkToken = () =>
  new BadRequestException({
    code: 'INVALID_OR_EXPIRED_TOKEN',
    message: 'This link is invalid, has already been used, or has expired. Request a new one.',
  });

export const invalidMfa = () =>
  new UnauthorizedException({
    code: 'INVALID_MFA_CODE',
    message: 'That code is not valid. Try the latest code.',
  });

export const mfaChallengeExpired = () =>
  new UnauthorizedException({
    code: 'MFA_CHALLENGE_EXPIRED',
    message: 'This sign-in attempt has expired or had too many wrong codes. Sign in again.',
  });
