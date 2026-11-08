import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { AppConfig } from '../../config/app-config.js';
import type { ClientType, RoleKey } from '../../generated/prisma/client.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MFA_TOKEN_TTL_SECONDS = 5 * 60;

const ISSUER = 'attendsure-api';
// Different audiences mean a two-step-sign-in token can never be used as an access token, or vice versa.
const ACCESS_AUDIENCE = 'attendsure-access';
const MFA_AUDIENCE = 'attendsure-mfa';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  role: RoleKey;
}

export interface MfaClaims {
  userId: string;
  client: ClientType;
  role: RoleKey;
  /** Unique per challenge; used to count wrong codes. */
  challengeId: string;
}

/** Signs and checks the short-lived tokens the API hands out (HMAC-SHA-256 JWTs). */
@Injectable()
export class TokenService {
  constructor(private readonly config: AppConfig) {}

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({ sid: claims.sessionId, role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.config.jwtAccessSecret);
    return { token, expiresAt };
  }

  /** Returns the claims, or null if the token is malformed, tampered with, expired or of the wrong kind. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.config.jwtAccessSecret, {
        issuer: ISSUER,
        audience: ACCESS_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.role !== 'string'
      ) {
        return null;
      }
      return { userId: payload.sub, sessionId: payload.sid, role: payload.role as RoleKey };
    } catch {
      return null;
    }
  }

  async signMfa(claims: Omit<MfaClaims, 'challengeId'>): Promise<string> {
    return new SignJWT({ client: claims.client, role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setJti(randomUUID())
      .setIssuer(ISSUER)
      .setAudience(MFA_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${MFA_TOKEN_TTL_SECONDS}s`)
      .sign(this.config.jwtAccessSecret);
  }

  async verifyMfa(token: string): Promise<MfaClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.config.jwtAccessSecret, {
        issuer: ISSUER,
        audience: MFA_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.jti !== 'string' ||
        (payload.client !== 'WEB' && payload.client !== 'MOBILE') ||
        typeof payload.role !== 'string'
      ) {
        return null;
      }
      return {
        userId: payload.sub,
        client: payload.client,
        role: payload.role as RoleKey,
        challengeId: payload.jti,
      };
    } catch {
      return null;
    }
  }
}
