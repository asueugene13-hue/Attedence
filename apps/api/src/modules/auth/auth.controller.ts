import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ActivateRequestSchema,
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  MfaEnrollRequestSchema,
  MfaVerifyRequestSchema,
  RefreshRequestSchema,
  ResetPasswordRequestSchema,
  SwitchRoleRequestSchema,
} from '@attendsure/shared';
import type { CookieOptions, Request, Response } from 'express';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { AppConfig } from '../../config/app-config.js';
import { Authenticated, Public } from '../authorization/access.decorators.js';
import { CurrentAuth } from './access-token.guard.js';
import { signInAgain } from './auth-errors.js';
import { AuthService, type SessionTokens } from './auth.service.js';
import type { AccessClaims } from './token.service.js';

export const REFRESH_COOKIE = 'as_refresh';
const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true, // page scripts cannot read it, so an XSS bug cannot steal it
  secure: true, // HTTPS only (browsers also allow it on http://localhost)
  sameSite: 'strict', // never sent with requests started by another website
  path: '/api/v1/auth', // only sent to the sign-in endpoints
};

const MINUTE = 60;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @RateLimit(
    { name: 'login-ip', limit: 300, windowSeconds: MINUTE, by: 'ip' },
    { name: 'login-account', limit: 10, windowSeconds: 15 * MINUTE, by: 'ip+email' },
  )
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(parseInput(LoginRequestSchema, body), requestContextOf(req));
    if (result.kind === 'mfa') {
      return { mfaRequired: true, enrollmentRequired: result.enrollmentRequired, mfaToken: result.mfaToken };
    }
    return this.sessionResponse(result.tokens, res);
  }

  @Post('mfa/enroll')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'mfa-enroll', limit: 20, windowSeconds: 15 * MINUTE, by: 'ip' })
  async mfaEnroll(@Body() body: unknown) {
    return this.auth.startMfaEnrollment(parseInput(MfaEnrollRequestSchema, body).mfaToken);
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'mfa-verify', limit: 60, windowSeconds: MINUTE, by: 'ip' })
  async mfaVerify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { recoveryCodes, ...tokens } = await this.auth.verifyMfa(
      parseInput(MfaVerifyRequestSchema, body),
      requestContextOf(req),
    );
    const response = this.sessionResponse(tokens, res);
    return recoveryCodes ? { ...response, recoveryCodes } : response;
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @RateLimit({ name: 'refresh', limit: 600, windowSeconds: MINUTE, by: 'ip' })
  async refresh(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parseInput(RefreshRequestSchema, body);
    const context = requestContextOf(req);
    if (input.refreshToken) {
      return this.sessionResponse(await this.auth.refresh(input.refreshToken, 'MOBILE', context), res);
    }
    const cookie: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof cookie !== 'string' || cookie.length === 0) throw signInAgain();
    // The cookie is only honoured from the dashboard's own origin (protection against cross-site requests).
    if (req.headers.origin !== this.config.webAppOrigin) {
      throw new ForbiddenException({
        code: 'ORIGIN_REJECTED',
        message: 'This request did not come from AttendSure.',
      });
    }
    return this.sessionResponse(await this.auth.refresh(cookie, 'WEB', context), res);
  }

  @Post('switch-role')
  @Authenticated()
  @HttpCode(200)
  async switchRole(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    return this.auth.switchRole(auth, parseInput(SwitchRoleRequestSchema, body).role, requestContextOf(req));
  }

  @Post('logout')
  @Authenticated()
  @HttpCode(204)
  async logout(
    @CurrentAuth() auth: AccessClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(auth, requestContextOf(req));
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  }

  @Get('me')
  @Authenticated()
  async me(@CurrentAuth() auth: AccessClaims) {
    return this.auth.me(auth);
  }

  @Post('activate')
  @Public()
  @HttpCode(204)
  @RateLimit({ name: 'activate', limit: 30, windowSeconds: 15 * MINUTE, by: 'ip' })
  async activate(@Body() body: unknown, @Req() req: Request) {
    await this.auth.activate(parseInput(ActivateRequestSchema, body), requestContextOf(req));
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(202)
  @RateLimit(
    { name: 'forgot-ip', limit: 30, windowSeconds: 15 * MINUTE, by: 'ip' },
    { name: 'forgot-email', limit: 3, windowSeconds: 60 * MINUTE, by: 'email' },
  )
  async forgotPassword(@Body() body: unknown, @Req() req: Request) {
    await this.auth.requestPasswordReset(
      parseInput(ForgotPasswordRequestSchema, body).email,
      requestContextOf(req),
    );
    return {
      message: 'If an active account uses that email, a reset link is on its way. It expires in 30 minutes.',
    };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(204)
  @RateLimit({ name: 'reset', limit: 30, windowSeconds: 15 * MINUTE, by: 'ip' })
  async resetPassword(@Body() body: unknown, @Req() req: Request) {
    await this.auth.resetPassword(parseInput(ResetPasswordRequestSchema, body), requestContextOf(req));
  }

  @Post('password/change')
  @Authenticated()
  @HttpCode(204)
  @RateLimit({ name: 'password-change', limit: 10, windowSeconds: 15 * MINUTE, by: 'ip' })
  async changePassword(@CurrentAuth() auth: AccessClaims, @Body() body: unknown, @Req() req: Request) {
    await this.auth.changePassword(
      auth,
      parseInput(ChangePasswordRequestSchema, body),
      requestContextOf(req),
    );
  }

  /** Web sessions get the refresh token as an httpOnly cookie only; mobile apps get it in the body. */
  private sessionResponse(tokens: SessionTokens, res: Response) {
    if (tokens.client === 'WEB') {
      res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
        ...REFRESH_COOKIE_OPTIONS,
        expires: tokens.sessionExpiresAt,
      });
      const { refreshToken: _hidden, ...body } = tokens;
      return body;
    }
    return tokens;
  }
}
