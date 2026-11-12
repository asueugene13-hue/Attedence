import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DEVICE_HEADERS, DEVICE_SIGNATURE_MAX_SKEW_MS, deviceSigningPayload } from '@attendsure/shared';
import type { Request } from 'express';
import type { UserDevice } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import type { AccessClaims } from '../auth/token.service.js';

/** How long a used nonce is remembered: longer than the allowed clock difference either way. */
const NONCE_TTL_SECONDS = Math.ceil((2 * DEVICE_SIGNATURE_MAX_SKEW_MS) / 1000);
const LAST_SEEN_PRECISION_MS = 60_000;

type SignedRequest = Request & { auth?: AccessClaims; device?: UserDevice; rawBody?: Buffer };

const refused = (code: string, message: string) => new UnauthorizedException({ code, message });

/** A malformed signature (wrong length, bad encoding) is simply not a match. */
function signatureMatches(payload: string, key: KeyObject, signature: string): boolean {
  try {
    return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Requires a request signed by the caller's own phone (PRESENCE_VERIFICATION.md §5). Checks, in order:
 * the phone belongs to the signed-in person and is not revoked or replaced; the time is within
 * 5 minutes of the server's; the nonce has not been seen before; the Ed25519 signature over the exact
 * method, path, time, nonce and body bytes is valid for the phone's public key. Runs after sign-in.
 */
@Injectable()
export class DeviceSignatureGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SignedRequest>();
    const auth = req.auth;
    if (!auth) throw refused('UNAUTHENTICATED', 'Sign in first.');
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const deviceId = header(DEVICE_HEADERS.device);
    const timestamp = header(DEVICE_HEADERS.timestamp);
    const nonce = header(DEVICE_HEADERS.nonce);
    const signature = header(DEVICE_HEADERS.signature);
    if (!deviceId || !timestamp || !nonce || !signature) {
      throw refused('DEVICE_SIGNATURE_REQUIRED', 'This action must come from your registered phone.');
    }
    if (
      !/^[0-9a-f-]{36}$/i.test(deviceId) ||
      !/^\d{1,16}$/.test(timestamp) ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)
    ) {
      throw refused('DEVICE_SIGNATURE_INVALID', 'The phone’s signature is not valid.');
    }

    const device = await this.prisma.userDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== auth.userId || !device.publicKey) {
      throw refused('DEVICE_UNKNOWN', 'This phone is not registered to your account.');
    }
    if (device.status === 'REVOKED' || device.status === 'REPLACED') {
      throw new ForbiddenException({
        code: 'DEVICE_REVOKED',
        message: 'This phone can no longer be used. Ask for your new phone to be approved.',
      });
    }
    if (Math.abs(this.clock.now().getTime() - Number(timestamp)) > DEVICE_SIGNATURE_MAX_SKEW_MS) {
      throw refused(
        'DEVICE_CLOCK_SKEW',
        'Your phone’s clock is wrong. Set it to automatic time and try again.',
      );
    }

    const body = req.rawBody ?? Buffer.alloc(0);
    const payload = deviceSigningPayload({
      method: req.method,
      path: req.originalUrl,
      timestamp,
      nonce,
      bodySha256Hex: createHash('sha256').update(body).digest('hex'),
    });
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: device.publicKey }, format: 'jwk' });
    if (!signatureMatches(payload, key, signature)) {
      throw refused('DEVICE_SIGNATURE_INVALID', 'The phone’s signature is not valid.');
    }

    // Only now spend the nonce, so random junk cannot fill the store. A replayed request fails here.
    const fresh = await this.redis.client.set(
      `device-nonce:${device.id}:${nonce}`,
      '1',
      'EX',
      NONCE_TTL_SECONDS,
      'NX',
    );
    if (fresh !== 'OK') throw refused('DEVICE_SIGNATURE_REPLAYED', 'This request was already used.');

    // "Last seen" to the minute is enough (the shared-phone check looks back a day), so a burst of
    // signed requests does not write the same row each time.
    const now = this.clock.now();
    if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() >= LAST_SEEN_PRECISION_MS) {
      await this.prisma.userDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    }
    req.device = device;
    return true;
  }
}

/** The phone a signed request came from (set by DeviceSignatureGuard). */
export const SignedDevice = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<SignedRequest>().device!,
);
