import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { EmailSender, PushSender } from './channels.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [UsersModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, EmailSender, PushSender],
  exports: [NotificationsService],
})
export class NotificationsModule {}
