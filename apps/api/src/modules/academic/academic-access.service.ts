import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AccessClaims } from '../auth/token.service.js';
import { ScopeService } from '../authorization/scope.service.js';

const outOfScope = () =>
  new ForbiddenException({
    code: 'OUT_OF_SCOPE',
    message: 'This record is outside the faculty or department you manage.',
  });

/**
 * Where an administrator may change the academic structure. The Super Admin and university-wide
 * administrators may change anything; an administrator scoped to a faculty or department may only
 * change departments and programmes inside it. Institution-level records (faculties, levels, years,
 * semesters, holidays) need university-wide scope.
 */
@Injectable()
export class AcademicAccessService {
  constructor(private readonly scopes: ScopeService) {}

  private async scope(actor: AccessClaims) {
    if (actor.role === 'SUPER_ADMIN') return { institutionWide: true, facultyIds: [], departmentIds: [] };
    return this.scopes.scopeFor(actor.userId, actor.role);
  }

  async assertInstitutionWide(actor: AccessClaims): Promise<void> {
    if (!(await this.scope(actor)).institutionWide) {
      throw new ForbiddenException({
        code: 'INSTITUTION_SCOPE_REQUIRED',
        message: 'Only someone who manages the whole university can change this.',
      });
    }
  }

  async assertFaculty(actor: AccessClaims, facultyId: string): Promise<void> {
    const scope = await this.scope(actor);
    if (scope.institutionWide || scope.facultyIds.includes(facultyId)) return;
    throw outOfScope();
  }

  async assertDepartment(actor: AccessClaims, department: { id: string; facultyId: string }): Promise<void> {
    const scope = await this.scope(actor);
    if (
      scope.institutionWide ||
      scope.facultyIds.includes(department.facultyId) ||
      scope.departmentIds.includes(department.id)
    ) {
      return;
    }
    throw outOfScope();
  }
}
