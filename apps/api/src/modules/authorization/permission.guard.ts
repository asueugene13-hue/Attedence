import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { requestContextOf } from '../../common/request-context.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { ACCESS_RULE, type AccessRule } from './access.decorators.js';
import { PermissionService } from './permission.service.js';

/**
 * Runs after AccessTokenGuard. Enforces the route's declared rule, refuses routes with no rule,
 * and records refused permission checks in the audit log for security review.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Live connections: the gateway checks what each one may join (the same rules as the HTTP routes).
    if (context.getType() === 'ws') return true;
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_RULE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & { auth?: AccessClaims }>();

    if (!rule) {
      this.logger.error(
        `Route ${req.method} ${req.route?.path ?? req.url} declares no access rule; refused.`,
      );
      throw new ForbiddenException({ code: 'ACCESS_NOT_DECLARED', message: 'This action is not available.' });
    }
    if (rule.kind === 'public' || rule.kind === 'authenticated') return true;

    const auth = req.auth;
    if (!auth)
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to do this.',
      });

    const held = await this.permissions.forRole(auth.role);
    const missing = rule.keys.filter((key) => !held.has(key));
    if (missing.length === 0) return true;

    await this.audit.record({
      action: 'authz.denied',
      entityType: 'route',
      entityId: `${req.method} ${req.route?.path ?? req.path}`,
      actorUserId: auth.userId,
      actorRoleKey: auth.role,
      after: { missing },
      context: requestContextOf(req),
    });
    throw new ForbiddenException({
      code: 'PERMISSION_DENIED',
      message: 'You do not have permission to do this.',
    });
  }
}
