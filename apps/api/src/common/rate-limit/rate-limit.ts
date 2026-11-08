import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

export interface RateLimitRule {
  /** Short name for the bucket, e.g. "login". */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Count per client IP, or per client IP and the email in the request body. */
  by: 'ip' | 'ip+email' | 'email';
}

const RATE_LIMITS = 'attendsure:rate-limits';

/** Extra limits for one route, on top of the default limit every route gets. */
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMITS, rules);

/**
 * Generous on purpose: a whole class can share one campus Wi-Fi address (NAT), so a strict per-IP limit
 * would block students at check-in. Sensitive routes add tighter, more specific limits.
 */
export const DEFAULT_RATE_LIMIT: RateLimitRule = {
  name: 'default',
  limit: 3000,
  windowSeconds: 60,
  by: 'ip',
};

function subjectOf(rule: RateLimitRule, req: Request): string | null {
  const ip = req.ip ?? 'unknown';
  if (rule.by === 'ip') return ip;
  const body = req.body as Record<string, unknown> | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
  if (!email) return rule.by === 'email' ? null : ip;
  // Emails are hashed so Redis never holds personal data.
  const hashed = createHash('sha256').update(email).digest('hex').slice(0, 32);
  return rule.by === 'email' ? hashed : `${ip}:${hashed}`;
}

/**
 * Fixed-window request limits counted in Redis, shared by every API instance.
 * If Redis is unavailable the request is allowed and the problem is logged: availability wins here,
 * and accounts are still protected by lock-out and two-step attempt limits.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const routeRules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(RATE_LIMITS, [
      context.getHandler(),
      context.getClass(),
    ]);
    const nowSeconds = Math.floor(Date.now() / 1000);

    for (const rule of [DEFAULT_RATE_LIMIT, ...(routeRules ?? [])]) {
      const subject = subjectOf(rule, req);
      if (subject === null) continue;
      const windowStart = nowSeconds - (nowSeconds % rule.windowSeconds);
      const key = `rl:${rule.name}:${windowStart}:${subject}`;
      let count: number;
      try {
        count = await this.redis.client.incr(key);
        if (count === 1) await this.redis.client.expire(key, rule.windowSeconds);
      } catch (error) {
        this.logger.error(`Rate limiting skipped (Redis unavailable): ${(error as Error).message}`);
        return true;
      }
      if (count > rule.limit) {
        res.setHeader('Retry-After', String(windowStart + rule.windowSeconds - nowSeconds));
        throw new HttpException(
          { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment and try again.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }
}
