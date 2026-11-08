import { type CanActivate, createParamDecorator, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { signInAgain } from './auth-errors.js';
import { SessionService } from './session.service.js';
import { type AccessClaims, TokenService } from './token.service.js';

type AuthedRequest = Request & { auth?: AccessClaims };

/**
 * Requires a valid access token whose session is still open and whose user is still active.
 * Checking the session on every request means logout, password reset and suspension take effect
 * immediately, not when the 15-minute token expires.
 * (Step 5 makes authentication the default for every route and adds permission checks.)
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw signInAgain();

    const claims = await this.tokens.verifyAccess(header.slice('Bearer '.length).trim());
    if (!claims) throw signInAgain();

    const session = await this.sessions.findActive(claims.sessionId);
    if (!session || session.userId !== claims.userId || session.activeRoleKey !== claims.role)
      throw signInAgain();

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
