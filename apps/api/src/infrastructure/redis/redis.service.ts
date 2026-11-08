import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.js';

/** Shared Redis connection (rate limits, job queues and socket fan-out arrive in later steps). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfig) {
    this.client = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    // Without a listener, ioredis would print unhandled errors; log them through the app logger instead.
    this.client.on('error', (error: Error) => this.logger.error(`Redis connection error: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
