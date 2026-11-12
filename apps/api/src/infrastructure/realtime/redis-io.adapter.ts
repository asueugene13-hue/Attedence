import { type INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { AppConfig } from '../../config/app-config.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Live connections (Socket.IO) that share events through Redis, so a lecturer's screen connected to
 * one API server still hears check-ins handled by another. Connections are accepted only from the
 * web app's address; who may join what is checked by each gateway.
 *
 * Redis is used only once its connections are ready. Until then (or if Redis is down when the API
 * starts), Socket.IO's own in-memory adapter serves the screens connected to this server, and nothing
 * fails or piles up waiting for Redis.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private readonly clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const config = this.app.get(AppConfig);
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: config.webAppUrl, credentials: true },
    } as ServerOptions) as Server;

    const redis = this.app.get(RedisService).client;
    const pub = redis.duplicate({ lazyConnect: true });
    const sub = redis.duplicate({ lazyConnect: true });
    this.clients.push(pub, sub);
    let shared = false;
    const share = () => {
      if (shared || pub.status !== 'ready' || sub.status !== 'ready') return;
      shared = true;
      server.adapter(createAdapter(pub, sub));
      // Screens that connected before Redis was ready were in the old adapter's rooms: ask them to
      // reconnect and rejoin (they then reload the roster), rather than silently miss events.
      const namespaces = (server as unknown as { _nsps: Map<string, { disconnectSockets(): void }> })._nsps;
      for (const nsp of namespaces.values()) nsp.disconnectSockets();
      this.log.log('Live events are shared through Redis.');
    };
    for (const client of [pub, sub]) {
      client.on('ready', share);
      client.on('error', (error: Error) =>
        this.log.warn(`Live events: Redis connection error: ${error.message}`),
      );
      client.connect().catch((error: unknown) => {
        this.log.warn(
          `Live events: Redis not reachable yet, serving this server's screens only: ${String(error)}`,
        );
      });
    }
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all(this.clients.splice(0).map((c) => c.quit().catch(() => c.disconnect())));
  }
}
