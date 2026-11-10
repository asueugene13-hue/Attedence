import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { RateLimitGuard } from './common/rate-limit/rate-limit.js';
import { ConfigModule } from './config/config.module.js';
import { ClockModule } from './infrastructure/clock/clock.js';
import { CryptoModule } from './infrastructure/crypto/crypto.module.js';
import { JobRunnerModule, JobsModule } from './infrastructure/jobs/jobs.module.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';
import { MailModule } from './infrastructure/mail/mail.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { AcademicModule } from './modules/academic/academic.module.js';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module.js';
import { AuditModule } from './modules/audit-logs/audit.module.js';
import { AccessTokenGuard } from './modules/auth/access-token.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AuthorizationModule } from './modules/authorization/authorization.module.js';
import { ClassSessionsModule } from './modules/class-sessions/class-sessions.module.js';
import { DevicesModule } from './modules/devices/devices.module.js';
import { RiskFlagsModule } from './modules/risk-flags/risk-flags.module.js';
import { PermissionGuard } from './modules/authorization/permission.guard.js';
import { CoursesModule } from './modules/courses/courses.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module.js';
import { ImportsModule } from './modules/imports/imports.module.js';
import { PlacesModule } from './modules/places/places.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { StudentsModule } from './modules/students/students.module.js';
import { TimetablesModule } from './modules/timetables/timetables.module.js';
import { UsersModule } from './modules/users/users.module.js';

/** Shared infrastructure used by both the API and the worker process. */
export const INFRASTRUCTURE_MODULES = [
  ConfigModule,
  LoggingModule,
  PrismaModule,
  RedisModule,
  CryptoModule,
  MailModule,
  AuditModule,
  ClockModule,
  JobsModule,
];

@Module({
  imports: [
    ...INFRASTRUCTURE_MODULES,
    // File storage is used by the API only; the worker gains it when a job needs files.
    StorageModule,
    AuthorizationModule,
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    AuditLogsModule,
    AcademicModule,
    PlacesModule,
    CoursesModule,
    StudentsModule,
    EnrollmentsModule,
    ImportsModule,
    SettingsModule,
    TimetablesModule,
    ClassSessionsModule,
    DevicesModule,
    RiskFlagsModule,
    // Runs background jobs in this process only when RUN_JOBS_IN_API=true; the worker always runs them.
    JobRunnerModule.forRoot('fromConfig'),
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    // Every request passes these in order: request limits, then sign-in, then permissions.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useExisting: AccessTokenGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },
  ],
})
export class AppModule {}
