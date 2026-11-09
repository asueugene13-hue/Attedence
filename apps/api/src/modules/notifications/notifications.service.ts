import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationChannel,
} from '@attendsure/shared';
import type { NotificationPriority, Prisma } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AccountsService } from '../users/accounts.service.js';
import { type ChannelSender, EmailSender, PushSender } from './channels.js';

export interface NotifyInput {
  userIds: string[];
  category: NotificationCategory;
  title: string;
  body: string;
  /** Where it leads (`path`) and which action buttons the apps show (`actions`). */
  data?: { path?: string; actions?: string[]; [key: string]: Prisma.InputJsonValue | undefined };
  priority?: NotificationPriority;
  related?: { type: string; id: string };
  /** The same key for the same person is never notified twice (a re-run job is safe). */
  dedupeKey?: string;
  /** Also email it if still unread after this many minutes (and email is not already used). */
  emailIfUnreadAfterMinutes?: number;
}

const MINUTE = 60_000;

/**
 * Stores and delivers notifications (Phase 3 step 6). Every notification is shown in the app. Email
 * (and push, once enabled) go out from background jobs with retries; each delivery has a record.
 * Other modules decide who is told what, and call notify().
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly senders: Map<string, ChannelSender>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRegistry,
    private readonly outbox: OutboxService,
    private readonly accounts: AccountsService,
    private readonly clock: Clock,
    email: EmailSender,
    push: PushSender,
  ) {
    this.senders = new Map<string, ChannelSender>([
      ['EMAIL', email],
      ['PUSH', push],
    ]);
  }

  onModuleInit(): void {
    this.jobs.define<{ deliveryId: string }>({
      queue: 'email',
      name: 'notification',
      attempts: 5,
      handle: async (data, ctx) => this.deliver(data.deliveryId, ctx.isFinalAttempt),
    });
    this.jobs.define({
      queue: 'system',
      name: 'notifications-unread-email',
      attempts: 3,
      handle: async () => {
        await this.emailUnread();
      },
    });
    this.jobs.every('system', 'notifications-unread-email', 60_000);
  }

  /** Creates the notifications and queues their deliveries, all in one transaction. */
  async notify(input: NotifyInput): Promise<number> {
    const userIds = [...new Set(input.userIds)];
    if (userIds.length === 0) return 0;
    const rule = NOTIFICATION_CATEGORIES[input.category];
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: userIds }, category: input.category },
    });
    const off = new Set(prefs.filter((p) => !p.enabled).map((p) => `${p.userId}|${p.channel}`));
    const channels = (rule.defaultChannels as readonly NotificationChannel[]).filter(
      (c) => c !== 'IN_APP' && this.senders.get(c)?.isEnabled(),
    );
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.notification.createManyAndReturn({
        data: userIds.map((userId) => ({
          userId,
          category: input.category,
          title: input.title,
          body: input.body,
          data: input.data as Prisma.InputJsonValue | undefined,
          priority: input.priority ?? 'NORMAL',
          relatedEntityType: input.related?.type,
          relatedEntityId: input.related?.id,
          dedupeKey: input.dedupeKey,
          emailIfUnreadAt:
            input.emailIfUnreadAfterMinutes && !channels.includes('EMAIL')
              ? new Date(now.getTime() + input.emailIfUnreadAfterMinutes * MINUTE)
              : null,
          createdAt: now,
        })),
        skipDuplicates: true,
        select: { id: true, userId: true },
      });
      for (const n of created) {
        for (const channel of channels) {
          if (!rule.mandatory && off.has(`${n.userId}|${channel}`)) continue;
          await this.queueDelivery(tx, n.id, channel);
        }
      }
      return created.length;
    });
  }

  // ───────── The signed-in person's own notifications ─────────

  async list(userId: string, query: { unread: boolean; limit: number; cursor?: string }) {
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(query.unread ? { readAt: null } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((n) => ({
        id: n.id,
        category: n.category,
        title: n.title,
        body: n.body,
        data: n.data,
        priority: n.priority,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
    };
  }

  async unreadCount(userId: string) {
    return { unread: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(userId: string, id: string) {
    const done = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: this.clock.now(), emailIfUnreadAt: null },
    });
    if (done.count === 0 && !(await this.prisma.notification.count({ where: { id, userId } }))) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such notification.' });
    }
    return this.unreadCount(userId);
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: this.clock.now(), emailIfUnreadAt: null },
    });
    return this.unreadCount(userId);
  }

  /** Every category with whether each outside channel is on for this person. */
  async preferences(userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const byKey = new Map(rows.map((r) => [`${r.category}|${r.channel}`, r.enabled]));
    return {
      data: Object.entries(NOTIFICATION_CATEGORIES).map(([category, rule]) => ({
        category,
        label: rule.label,
        mandatory: rule.mandatory,
        channels: (['EMAIL', 'PUSH'] as const).map((channel) => ({
          channel,
          available: this.senders.get(channel)!.isEnabled(),
          enabled:
            rule.mandatory ||
            (byKey.get(`${category}|${channel}`) ??
              (rule.defaultChannels as readonly string[]).includes(channel)),
        })),
      })),
    };
  }

  async setPreference(
    userId: string,
    input: { category: NotificationCategory; channel: 'EMAIL' | 'PUSH'; enabled: boolean },
  ) {
    if (NOTIFICATION_CATEGORIES[input.category].mandatory && !input.enabled) {
      throw new ConflictException({
        code: 'MANDATORY_CATEGORY',
        message: 'Messages about cancelled, moved or restored classes cannot be turned off.',
      });
    }
    await this.prisma.notificationPreference.upsert({
      where: { userId_category_channel: { userId, category: input.category, channel: input.channel } },
      create: { userId, category: input.category, channel: input.channel, enabled: input.enabled },
      update: { enabled: input.enabled },
    });
    return this.preferences(userId);
  }

  // ───────── Delivery ─────────

  private async queueDelivery(
    tx: Prisma.TransactionClient,
    notificationId: string,
    channel: NotificationChannel,
  ) {
    const delivery = await tx.notificationDelivery.create({ data: { notificationId, channel } });
    if (channel === 'EMAIL') await this.outbox.add(tx, 'email', 'notification', { deliveryId: delivery.id });
  }

  /** Sends one delivery. A person who cannot sign in (not active) is not emailed. */
  async deliver(deliveryId: string, isFinalAttempt = true): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: { notification: true },
    });
    if (!delivery || delivery.status !== 'QUEUED') return;
    const user = await this.accounts.find(delivery.notification.userId);
    if (!user || user.status !== 'ACTIVE') {
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: 'SUPPRESSED', lastError: 'The account is not active.' },
      });
      return;
    }
    const sender = this.senders.get(delivery.channel)!;
    const data = (delivery.notification.data ?? {}) as { path?: string };
    try {
      await sender.send({
        to: { email: user.email, fullName: user.fullName },
        title: delivery.notification.title,
        body: delivery.notification.body,
        path: data.path,
      });
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: 'SENT', sentAt: this.clock.now(), attempts: { increment: 1 }, lastError: null },
      });
    } catch (error) {
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          attempts: { increment: 1 },
          lastError: (error as Error).message.slice(0, 2000),
          ...(isFinalAttempt ? { status: 'FAILED' } : {}),
        },
      });
      throw error;
    }
  }

  /** Emails notifications still unread at their "email if unread" time (for example a review alert). */
  async emailUnread(): Promise<number> {
    const due = await this.prisma.notification.findMany({
      where: { emailIfUnreadAt: { lte: this.clock.now() }, readAt: null },
      take: 500,
    });
    let queued = 0;
    for (const n of due) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.notification.updateMany({
          where: { id: n.id, emailIfUnreadAt: { not: null }, readAt: null },
          data: { emailIfUnreadAt: null },
        });
        if (claimed.count !== 1) return;
        const pref = await tx.notificationPreference.findUnique({
          where: { userId_category_channel: { userId: n.userId, category: n.category, channel: 'EMAIL' } },
        });
        if (pref && !pref.enabled) return;
        await this.queueDelivery(tx, n.id, 'EMAIL');
        queued += 1;
      });
    }
    if (queued > 0) this.logger.log(`Emailed ${queued} unread notification(s).`);
    return queued;
  }
}
