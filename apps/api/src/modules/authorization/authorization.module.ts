import { Global, Module } from '@nestjs/common';
import { PermissionGuard } from './permission.guard.js';
import { PermissionService } from './permission.service.js';
import { ScopeService } from './scope.service.js';

@Global()
@Module({
  providers: [PermissionService, ScopeService, PermissionGuard],
  exports: [PermissionService, ScopeService, PermissionGuard],
})
export class AuthorizationModule {}
