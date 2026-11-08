import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_LABELS,
} from '@attendsure/shared';
import type { PrismaClient } from '../generated/prisma/client.js';

export interface SeedSummary {
  rolesCreated: number;
  permissionsCreated: number;
  permissionsUpdated: number;
  grantsAdded: number;
  /** Permissions in the database that the catalogue no longer lists. Reported, never deleted. */
  unknownPermissions: string[];
}

/**
 * Loads the six system roles, the permission catalogue and the default role grants from
 * packages/shared. This is the ONLY seed data in production: it never creates people, courses or rooms.
 *
 * Safe to run any number of times. It adds new roles and permissions (with their default grants) and
 * updates permission descriptions. It never adds or removes grants between roles and permissions that
 * already existed, so the Super Admin's changes to a role are kept.
 */
export async function seedSystemRoles(prisma: PrismaClient): Promise<SeedSummary> {
  return prisma.$transaction(async (tx) => {
    const summary: SeedSummary = {
      rolesCreated: 0,
      permissionsCreated: 0,
      permissionsUpdated: 0,
      grantsAdded: 0,
      unknownPermissions: [],
    };

    const existingRoles = new Set((await tx.role.findMany({ select: { key: true } })).map((r) => r.key));
    for (const key of ROLE_KEYS) {
      await tx.role.upsert({ where: { key }, create: { key, name: ROLE_LABELS[key] }, update: {} });
      if (!existingRoles.has(key)) summary.rolesCreated += 1;
    }

    const existingPermissions = new Map((await tx.permission.findMany()).map((p) => [p.key, p] as const));
    for (const key of PERMISSION_KEYS) {
      const { description, protected: isProtected } = PERMISSIONS[key];
      const current = existingPermissions.get(key);
      if (!current) {
        await tx.permission.create({ data: { key, description, isProtected } });
        summary.permissionsCreated += 1;
      } else if (current.description !== description || current.isProtected !== isProtected) {
        await tx.permission.update({ where: { key }, data: { description, isProtected } });
        summary.permissionsUpdated += 1;
      }
    }
    const catalogue = new Set<string>(PERMISSION_KEYS);
    summary.unknownPermissions = [...existingPermissions.keys()].filter((k) => !catalogue.has(k)).sort();

    const roleIds = new Map((await tx.role.findMany()).map((r) => [r.key, r.id] as const));
    const permissionIds = new Map((await tx.permission.findMany()).map((p) => [p.key, p.id] as const));
    // Default grants are added only where the role or the permission is new in this run. Once they exist,
    // the Super Admin owns the role's permissions: a default they removed on purpose is not put back.
    const grants = ROLE_KEYS.flatMap((roleKey) =>
      DEFAULT_ROLE_PERMISSIONS[roleKey]
        .filter((permissionKey) => !existingRoles.has(roleKey) || !existingPermissions.has(permissionKey))
        .map((permissionKey) => ({
          roleId: roleIds.get(roleKey)!,
          permissionId: permissionIds.get(permissionKey)!,
        })),
    );
    const added = await tx.rolePermission.createMany({ data: grants, skipDuplicates: true });
    summary.grantsAdded = added.count;

    return summary;
  });
}
