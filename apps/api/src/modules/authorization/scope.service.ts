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

  /**
   * Active people holding `role` whose scope covers a department: those granted that department or
   * its faculty; if there are none, those with institution-wide scope (CLASS_MONITORING.md §4).
   */
  async holdersCovering(role: RoleKey, department: { id: string; facultyId: string }): Promise<string[]> {
    const grants = await this.prisma.userRole.findMany({
      where: { revokedAt: null, role: { key: role }, user: { status: 'ACTIVE' } },
      select: { userId: true, scopeType: true, scopeId: true },
    });
    const narrow = grants.filter(
      (g) =>
        (g.scopeType === 'DEPARTMENT' && g.scopeId === department.id) ||
        (g.scopeType === 'FACULTY' && g.scopeId === department.facultyId),
    );
    const chosen = narrow.length > 0 ? narrow : grants.filter((g) => g.scopeType === 'INSTITUTION');
    return [...new Set(chosen.map((g) => g.userId))];
  }

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
