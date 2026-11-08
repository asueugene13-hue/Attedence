import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verifySync } from 'otplib';
import type { User } from '../../generated/prisma/client.js';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service.js';
import { hashToken } from '../../infrastructure/crypto/tokens.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { MFA_TOKEN_TTL_SECONDS } from './token.service.js';

export const RECOVERY_CODE_COUNT = 10;
/** Wrong codes allowed per sign-in attempt. A 6-digit code has a million options; 5 guesses is 0.0005%. */
export const MAX_MFA_ATTEMPTS = 5;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ISSUER = 'AttendSure';

function newRecoveryCode(): string {
  const chars = Array.from({ length: 10 }, () => BASE32[randomInt(BASE32.length)]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/-/g, '');
}

/** Two-step sign-in with an authenticator app (TOTP, RFC 6238), plus single-use recovery codes. */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly redis: RedisService,
  ) {}

  /** Creates (or replaces) the not-yet-confirmed secret and returns what the authenticator app needs. */
  async startEnrollment(user: Pick<User, 'id' | 'email'>): Promise<{ secret: string; otpauthUri: string }> {
    const secret = generateSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaSecretEnc: this.encryption.encrypt(secret), mfaLastTimeStep: null },
    });
    return { secret, otpauthUri: generateURI({ issuer: ISSUER, label: user.email, secret }) };
  }

  /**
   * Checks a 6-digit code (allowing one 30-second step of clock drift) and records its time step,
   * so the same code cannot be used again, not even by a request racing this one.
   */
  async verifyCode(
    user: Pick<User, 'id' | 'mfaSecretEnc' | 'mfaLastTimeStep'>,
    code: string,
  ): Promise<boolean> {
    if (!user.mfaSecretEnc) return false;
    const secret = this.encryption.decrypt(user.mfaSecretEnc);
    const result = verifySync({ secret, token: code, epochTolerance: 30 });
    if (!result.valid || !('timeStep' in result)) return false;
    const step = result.timeStep;
    if (user.mfaLastTimeStep !== null && step <= user.mfaLastTimeStep) return false;
    const claimed = await this.prisma.user.updateMany({
      where: { id: user.id, OR: [{ mfaLastTimeStep: null }, { mfaLastTimeStep: { lt: step } }] },
      data: { mfaLastTimeStep: step },
    });
    return claimed.count === 1;
  }

  /** Turns MFA on and returns fresh recovery codes. They are shown once and only their hashes are kept. */
  async completeEnrollment(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.prisma.$transaction([
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.mfaRecoveryCode.createMany({
        data: codes.map((code) => ({ userId, codeHash: hashToken(normaliseRecoveryCode(code)) })),
      }),
      this.prisma.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date() } }),
    ]);
    return codes;
  }

  async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const used = await this.prisma.mfaRecoveryCode.updateMany({
      where: { userId, codeHash: hashToken(normaliseRecoveryCode(code)), usedAt: null },
      data: { usedAt: new Date() },
    });
    return used.count === 1;
  }

  /** Counts a wrong code for this sign-in attempt. Returns false once the attempt is used up. */
  async registerFailedAttempt(challengeId: string): Promise<boolean> {
    const key = `mfa:attempts:${challengeId}`;
    const attempts = await this.redis.client.incr(key);
    if (attempts === 1) await this.redis.client.expire(key, MFA_TOKEN_TTL_SECONDS);
    return attempts < MAX_MFA_ATTEMPTS;
  }

  async isChallengeExhausted(challengeId: string): Promise<boolean> {
    const attempts = Number((await this.redis.client.get(`mfa:attempts:${challengeId}`)) ?? 0);
    return attempts >= MAX_MFA_ATTEMPTS;
  }
}
