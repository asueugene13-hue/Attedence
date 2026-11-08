import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ActivateRequestSchema,
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  MfaEnrollRequestSchema,
  MfaVerifyRequestSchema,
  RefreshRequestSchema,
  ResetPasswordRequestSchema,
} from '@attendsure/shared';
import type { CookieOptions, Request, Response } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { parseInput } from '../../common/validation/parse-input.js';
import { AppConfig } from '../../config/app-config.js';
import { AccessTokenGuard, CurrentAuth } from './access-token.guard.js';
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

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(parseInput(LoginRequestSchema, body), requestContextOf(req));
    if (result.kind === 'mfa') {
      return { mfaRequired: true, enrollmentRequired: result.enrollmentRequired, mfaToken: result.mfaToken };
    }
    return this.sessionResponse(result.tokens, res);
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  async mfaEnroll(@Body() body: unknown) {
    return this.auth.startMfaEnrollment(parseInput(MfaEnrollRequestSchema, body).mfaToken);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  async mfaVerify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { recoveryCodes, ...tokens } = await this.auth.verifyMfa(
      parseInput(MfaVerifyRequestSchema, body),
      requestContextOf(req),
    );
    const response = this.sessionResponse(tokens, res);
    return recoveryCodes ? { ...response, recoveryCodes } : response;
  }

  @Post('refresh')
  @HttpCode(200)
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

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async logout(
    @CurrentAuth() auth: AccessClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(auth, requestContextOf(req));
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  async me(@CurrentAuth() auth: AccessClaims) {
    return this.auth.me(auth);
  }

  @Post('activate')
  @HttpCode(204)
  async activate(@Body() body: unknown, @Req() req: Request) {
    await this.auth.activate(parseInput(ActivateRequestSchema, body), requestContextOf(req));
  }

  @Post('password/forgot')
  @HttpCode(202)
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
  @HttpCode(204)
  async resetPassword(@Body() body: unknown, @Req() req: Request) {
    await this.auth.resetPassword(parseInput(ResetPasswordRequestSchema, body), requestContextOf(req));
  }

  @Post('password/change')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
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
