import { Injectable } from '@nestjs/common';
import type { NotificationChannel } from '@attendsure/shared';
import { AppConfig } from '../../config/app-config.js';
import { MailService } from '../../infrastructure/mail/mail.service.js';

export interface OutgoingMessage {
  to: { email: string; fullName: string };
  title: string;
  body: string;
  /** Path in the web app this message leads to, if any. */
  path?: string;
}

/**
 * One way of reaching people outside the app. IN_APP needs no sender: the notification row is the
 * message. A channel that is not enabled gets no deliveries at all.
 */
export interface ChannelSender {
  readonly channel: Exclude<NotificationChannel, 'IN_APP'>;
  isEnabled(): boolean;
  send(message: OutgoingMessage): Promise<void>;
}

@Injectable()
export class EmailSender implements ChannelSender {
  readonly channel = 'EMAIL' as const;

  constructor(
    private readonly mail: MailService,
    private readonly config: AppConfig,
  ) {}

  isEnabled(): boolean {
    return true;
  }

  async send(message: OutgoingMessage): Promise<void> {
    const link = message.path ? `\n\nOpen AttendSure: ${this.config.webAppUrl}${message.path}` : '';
    await this.mail.send({
      to: message.to.email,
      subject: message.title,
      text: `Hello ${message.to.fullName},\n\n${message.body}${link}\n\nThis message was sent by AttendSure, Knutsford University.`,
    });
  }
}

/**
 * Push notifications (Firebase Cloud Messaging). Switched off by decision of 2026-11-09 until the
 * university has its own Firebase project; until then no push deliveries are created. Turning it on
 * means implementing send() with the Firebase Admin SDK and device tokens, then enabling it here.
 */
@Injectable()
export class PushSender implements ChannelSender {
  readonly channel = 'PUSH' as const;

  isEnabled(): boolean {
    return false;
  }

  async send(): Promise<void> {
    throw new Error('Push notifications are not set up: they need a university-owned Firebase project.');
  }
}
