import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

const PING_TIMEOUT_MS = 1500;

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly redis: RedisService,
  ) {}

  async isHealthy(key: string) {
    const check = this.indicator.check(key);
    try {
      const reply = await Promise.race([
        this.redis.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`no reply within ${PING_TIMEOUT_MS} ms`)), PING_TIMEOUT_MS),
        ),
      ]);
      return reply === 'PONG' ? check.up() : check.down({ message: `unexpected reply: ${reply}` });
    } catch (error) {
      return check.down({ message: error instanceof Error ? error.message : 'unknown error' });
    }
  }
}
