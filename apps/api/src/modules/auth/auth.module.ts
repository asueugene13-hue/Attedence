import { Module } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard.js';
import { AccountTokensService } from './account-tokens.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    MfaService,
    AccountTokensService,
    AccessTokenGuard,
  ],
  exports: [AuthService, AccessTokenGuard, TokenService, SessionService, AccountTokensService],
})
export class AuthModule {}
