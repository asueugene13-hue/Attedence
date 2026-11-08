import { Injectable, Logger } from '@nestjs/common';
import type { RoleKey } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

const CACHE_SECONDS = 60;
const cacheKey = (role: RoleKey) => `perm:role:${role}`;

/**
 * Which permissions each role holds. Read on every protected request, so results are cached in Redis
 * for 60 seconds; changing a role's permissions (step 6) calls invalidate() so the change applies at once.
 * The database stays the source of truth: if Redis is unavailable, the database is read directly.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async forRole(role: RoleKey): Promise<ReadonlySet<string>> {
    try {
      const cached = await this.redis.client.get(cacheKey(role));
      if (cached !== null) return new Set(JSON.parse(cached) as string[]);
    } catch (error) {
      this.logger.warn(`Permission cache unavailable, reading the database: ${(error as Error).message}`);
    }

    const grants = await this.prisma.rolePermission.findMany({
      where: { role: { key: role } },
      select: { permission: { select: { key: true } } },
    });
    const keys = grants.map((g) => g.permission.key).sort();
    this.redis.client
      .set(cacheKey(role), JSON.stringify(keys), 'EX', CACHE_SECONDS)
      .catch((error: Error) => this.logger.warn(`Could not cache permissions for ${role}: ${error.message}`));
    return new Set(keys);
  }

  async invalidate(role: RoleKey): Promise<void> {
    await this.redis.client.del(cacheKey(role));
  }
}
