import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccountsService } from './accounts.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule, AcademicModule],
  controllers: [UsersController],
  providers: [UsersService, AccountsService],
  exports: [AccountsService],
})
export class UsersModule {}
