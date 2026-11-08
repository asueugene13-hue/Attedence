import { type CanActivate, createParamDecorator, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MFA_REQUIRED_ROLES } from '@attendsure/shared';
import type { Request } from 'express';
import { ACCESS_RULE, type AccessRule } from '../authorization/access.decorators.js';
import { signInAgain } from './auth-errors.js';
import { SessionService } from './session.service.js';
import { type AccessClaims, TokenService } from './token.service.js';

type AuthedRequest = Request & { auth?: AccessClaims };

/**
 * Registered for every route. Requires a valid access token unless the route is @Public().
 * The token's session must still be open, its user active, its role the session's active role, and a
 * staff role must come from a sign-in that passed two-step verification. Checking the session on every
 * request means sign-out, password reset and suspension take effect immediately.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_RULE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rule?.kind === 'public') return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw signInAgain();

    const claims = await this.tokens.verifyAccess(header.slice('Bearer '.length).trim());
    if (!claims) throw signInAgain();

    const session = await this.sessions.findActive(claims.sessionId);
    if (!session || session.userId !== claims.userId || session.activeRoleKey !== claims.role) {
      throw signInAgain();
    }
    if (MFA_REQUIRED_ROLES.includes(claims.role) && !session.mfaVerifiedAt) throw signInAgain();

    req.auth = claims;
    return true;
  }
}

/** The signed-in caller, as checked by AccessTokenGuard. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AccessClaims => {
  const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw signInAgain();
  return auth;
});
