import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfig } from '../../config/app-config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends email over SMTP (Mailpit locally, the provider chosen under D-17 in production).
 * Phase 3 moves sending onto the background worker with retries and delivery records; until then,
 * failures are logged and surfaced to the caller rather than ignored.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;

  constructor(private readonly config: AppConfig) {
    const { host, port, secure, user, password } = config.smtp;
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && password ? { user, pass: password } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.config.smtp.from, ...message });
    } catch (error) {
      this.logger.error(`Email "${message.subject}" could not be sent: ${(error as Error).message}`);
      throw error;
    }
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
