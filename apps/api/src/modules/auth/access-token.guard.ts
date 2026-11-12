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
    // Live connections (WebSockets) are signed in once, when they connect (the gateway calls
    // claimsFor); every message on them must come from a connection that passed.
    if (context.getType() === 'ws') {
      return Boolean(context.switchToWs().getClient<{ data?: { claims?: AccessClaims } }>().data?.claims);
    }
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_RULE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rule?.kind === 'public') return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw signInAgain();

    const claims = await this.claimsFor(header.slice('Bearer '.length).trim());
    if (!claims) throw signInAgain();
    req.auth = claims;
    return true;
  }

  /**
   * The caller behind an access token, or null: the token must be valid and its session still open,
   * for the same user and active role, with two-step verification for staff roles. Also used for
   * live connections (WebSockets), so they follow exactly the same rules as HTTP requests.
   */
  async claimsFor(token: string): Promise<AccessClaims | null> {
    const claims = await this.tokens.verifyAccess(token);
    if (!claims) return null;
    const session = await this.sessions.findActive(claims.sessionId);
    if (!session || session.userId !== claims.userId || session.activeRoleKey !== claims.role) return null;
    if (MFA_REQUIRED_ROLES.includes(claims.role) && !session.mfaVerifiedAt) return null;
    return claims;
  }
}

/** The signed-in caller, as checked by AccessTokenGuard. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AccessClaims => {
  const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw signInAgain();
  return auth;
});
