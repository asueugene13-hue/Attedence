import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ATTENDANCE_AND_CLASS_CONTROL_PERMISSIONS,
  CONFIGURABLE_ROLE_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type PermissionKey,
  ROLE_LABELS,
  isPermissionKey,
} from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import type { RoleKey } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';

/**
 * Permissions a role may ever hold: its defaults plus the "configurable" cells of the permission matrix.
 * Anything else (a registrar opening attendance, a student correcting records) cannot be granted.
 */
export function assignablePermissions(role: RoleKey): ReadonlySet<PermissionKey> {
  const keys = new Set<PermissionKey>([
    ...DEFAULT_ROLE_PERMISSIONS[role],
    ...(CONFIGURABLE_ROLE_PERMISSIONS[role] ?? []),
  ]);
  if (role === 'STUDENT' || role === 'COURSE_REP') {
    for (const key of ATTENDANCE_AND_CLASS_CONTROL_PERMISSIONS) keys.delete(key);
  }
  return keys;
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: { permissions: { include: { permission: { select: { key: true } } } } },
    });
    return roles.map((role) => {
      const held = new Set(role.permissions.map((rp) => rp.permission.key));
      return {
        key: role.key,
        name: role.name,
        editable: role.key !== 'SUPER_ADMIN',
        permissions: [...held].sort(),
        assignable: [...assignablePermissions(role.key)].sort().map((key) => ({
          key,
          description: PERMISSIONS[key].description,
          held: held.has(key),
          isDefault: DEFAULT_ROLE_PERMISSIONS[role.key].includes(key),
        })),
      };
    });
  }

  /** Replaces the role's whole permission set. The Super Admin role itself is fixed, to prevent lock-out. */
  async replacePermissions(
    actor: AccessClaims,
    role: RoleKey,
    requested: string[],
    reason: string,
    context: RequestContext,
  ) {
    if (role === 'SUPER_ADMIN') {
      throw new BadRequestException({
        code: 'ROLE_NOT_EDITABLE',
        message: `${ROLE_LABELS.SUPER_ADMIN} permissions are fixed so the installation cannot be locked out.`,
      });
    }
    const allowed = assignablePermissions(role);
    const rejected = requested.filter((key) => !isPermissionKey(key) || !allowed.has(key));
    if (rejected.length > 0) {
      throw new BadRequestException({
        code: 'PERMISSION_NOT_ASSIGNABLE',
        message: `Some permissions cannot be given to the ${ROLE_LABELS[role]} role.`,
        errors: rejected.map((key) => ({
          field: 'permissions',
          message: `${key} is not assignable to this role`,
        })),
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const roleRow = await tx.role.findUniqueOrThrow({
        where: { key: role },
        include: { permissions: { include: { permission: true } } },
      });
      const before = roleRow.permissions.map((rp) => rp.permission.key).sort();
      const target = new Set(requested);
      const removed = roleRow.permissions.filter((rp) => !target.has(rp.permission.key));
      const added = requested.filter((key) => !before.includes(key)).sort();

      if (removed.length > 0) {
        await tx.rolePermission.deleteMany({
          where: { roleId: roleRow.id, permissionId: { in: removed.map((rp) => rp.permissionId) } },
        });
      }
      if (added.length > 0) {
        const ids = await tx.permission.findMany({ where: { key: { in: added } }, select: { id: true } });
        await tx.rolePermission.createMany({
          data: ids.map((p) => ({ roleId: roleRow.id, permissionId: p.id })),
        });
      }
      await this.audit.record(
        {
          action: 'roles.permissions_changed',
          entityType: 'role',
          entityId: role,
          actorUserId: actor.userId,
          actorRoleKey: actor.role,
          before: { permissions: before },
          after: {
            permissions: [...target].sort(),
            added,
            removed: removed.map((rp) => rp.permission.key).sort(),
          },
          reason,
          context,
        },
        tx,
      );
      return { changed: added.length + removed.length > 0 };
    });

    // After the commit, so no request can re-cache the old set in between.
    if (result.changed) await this.permissions.invalidate(role);
    return (await this.list()).find((r) => r.key === role);
  }
}
