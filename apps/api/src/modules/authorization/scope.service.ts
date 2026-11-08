import { Injectable } from '@nestjs/common';
import type { RoleKey, ScopeType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

export interface RoleScope {
  /** True when at least one grant of this role covers the whole university. */
  institutionWide: boolean;
  facultyIds: string[];
  departmentIds: string[];
}

/**
 * Where a role applies for a user, from their active grants. A University Administrator may be granted
 * one faculty, a few departments, or the whole institution. Services combine this with the resource
 * being touched (its faculty, department or section) to decide; those checks arrive with the academic
 * tables in Phase 2 and the section-level rules for lecturers and course reps after that.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async scopeFor(userId: string, role: RoleKey): Promise<RoleScope> {
    const grants = await this.prisma.userRole.findMany({
      where: { userId, revokedAt: null, role: { key: role } },
      select: { scopeType: true, scopeId: true },
    });
    const ids = (type: ScopeType) =>
      grants.filter((g) => g.scopeType === type && g.scopeId).map((g) => g.scopeId as string);
    return {
      institutionWide: grants.some((g) => g.scopeType === 'INSTITUTION'),
      facultyIds: ids('FACULTY'),
      departmentIds: ids('DEPARTMENT'),
    };
  }
}
