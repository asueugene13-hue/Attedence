import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateDepartmentSchema,
  CreateFacultySchema,
  CreateLevelSchema,
  CreateProgrammeSchema,
  UpdateDepartmentSchema,
  UpdateFacultySchema,
  UpdateLevelSchema,
  UpdateProgrammeSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { AcademicAccessService } from './academic-access.service.js';

const notFound = (what: string) => new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });
const codeInUse = (what: string) => ({
  unique: { code: 'CODE_IN_USE', message: `Another ${what} already uses that code.` },
});

/**
 * Faculties, departments, programmes and academic levels. Records are deactivated, never deleted,
 * so students, courses and history keep pointing at them. A parent cannot be deactivated while it
 * has active children, and nothing new can be added under an inactive parent.
 */
@Injectable()
export class AcademicStructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
  ) {}

  // ───────── Faculties ─────────

  listFaculties(includeInactive: boolean) {
    return this.prisma.faculty.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { departments: { where: { isActive: true } } } } },
    });
  }

  async createFaculty(
    actor: AccessClaims,
    input: z.output<typeof CreateFacultySchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const faculty = await tx.faculty.create({ data: input });
        await this.audit.record(
          this.entry(actor, 'academic.faculty.created', 'faculty', faculty.id, null, faculty, context),
          tx,
        );
        return faculty;
      })
      .catch((e: unknown) => rethrowAsConflict(e, codeInUse('faculty')));
  }

  async updateFaculty(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateFacultySchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const before = await tx.faculty.findUnique({ where: { id } });
        if (!before) throw notFound('faculty');
        if (input.isActive === false && before.isActive) {
          const active = await tx.department.count({ where: { facultyId: id, isActive: true } });
          if (active > 0) throw this.hasActiveChildren('faculty', active, 'department');
        }
        const after = await tx.faculty.update({ where: { id }, data: input });
        await this.audit.record(
          this.entry(actor, 'academic.faculty.updated', 'faculty', id, before, after, context),
          tx,
        );
        return after;
      })
      .catch((e: unknown) => rethrowAsConflict(e, codeInUse('faculty')));
  }

  // ───────── Departments ─────────

  listDepartments(includeInactive: boolean, facultyId?: string) {
    return this.prisma.department.findMany({
      where: { ...(includeInactive ? {} : { isActive: true }), ...(facultyId ? { facultyId } : {}) },
      orderBy: { name: 'asc' },
      include: {
        faculty: { select: { id: true, code: true, name: true } },
        _count: { select: { programmes: { where: { isActive: true } } } },
      },
    });
  }

  async createDepartment(
    actor: AccessClaims,
    input: z.output<typeof CreateDepartmentSchema>,
    context: RequestContext,
  ) {
    const faculty = await this.prisma.faculty.findUnique({ where: { id: input.facultyId } });
    if (!faculty) throw notFound('faculty');
    await this.access.assertFaculty(actor, faculty.id);
    if (!faculty.isActive) throw this.inactiveParent('faculty');
    return this.prisma
      .$transaction(async (tx) => {
        const department = await tx.department.create({ data: input });
        await this.audit.record(
          this.entry(
            actor,
            'academic.department.created',
            'department',
            department.id,
            null,
            department,
            context,
          ),
          tx,
        );
        return department;
      })
      .catch((e: unknown) => rethrowAsConflict(e, codeInUse('department')));
  }

  async updateDepartment(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateDepartmentSchema>,
    context: RequestContext,
  ) {
    const existing = await this.prisma.department.findUnique({ where: { id }, include: { faculty: true } });
    if (!existing) throw notFound('department');
    await this.access.assertDepartment(actor, existing);
    return this.prisma
      .$transaction(async (tx) => {
        const { faculty, ...before } = existing;
        if (input.isActive === false && before.isActive) {
          const active = await tx.programme.count({ where: { departmentId: id, isActive: true } });
          if (active > 0) throw this.hasActiveChildren('department', active, 'programme');
        }
        if (input.isActive === true && !before.isActive && !faculty.isActive)
          throw this.inactiveParent('faculty');
        const after = await tx.department.update({ where: { id }, data: input });
        await this.audit.record(
          this.entry(actor, 'academic.department.updated', 'department', id, before, after, context),
          tx,
        );
        return after;
      })
      .catch((e: unknown) => rethrowAsConflict(e, codeInUse('department')));
  }

  // ───────── Programmes ─────────

  listProgrammes(includeInactive: boolean, filter: { departmentId?: string; facultyId?: string }) {
    return this.prisma.programme.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
        ...(filter.facultyId ? { department: { facultyId: filter.facultyId } } : {}),
      },
      orderBy: { name: 'asc' },
      include: { department: { select: { id: true, code: true, name: true, facultyId: true } } },
    });
  }

  async createProgramme(
    actor: AccessClaims,
    input: z.output<typeof CreateProgrammeSchema>,
    context: RequestContext,
  ) {
    const department = await this.prisma.department.findUnique({ where: { id: input.departmentId } });
    if (!department) throw notFound('department');
    await this.access.assertDepartment(actor, department);
    if (!department.isActive) throw this.inactiveParent('department');
    return this.prisma
      .$transaction(async (tx) => {
        const programme = await tx.programme.create({ data: input });
        await this.audit.record(
          this.entry(
            actor,
            'academic.programme.created',
            'programme',
            programme.id,
            null,
            programme,
            context,
          ),
          tx,
        );
        return programme;
      })
      .catch((e: unknown) => rethrowAsConflict(e, codeInUse('programme')));
  }

  async updateProgramme(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateProgrammeSchema>,
    context: RequestContext,
  ) {
    const existing = await this.prisma.programme.findUnique({ where: { id }, include: { department: true } });
    if (!existing) throw notFound('programme');
    await this.access.assertDepartment(actor, existing.department);
    return this.prisma
      .$transaction(async (tx) => {
        const { department, ...before } = existing;
        if (input.isActive === true && !before.isActive && !department.isActive)
          throw this.inactiveParent('department');
        const after = await tx.programme.update({ where: { id }, data: input });
        await this.audit.record(
          this.entry(actor, 'academic.programme.updated', 'programme', id, before, after, context),
          tx,
        );
        return after;
      })
      .catch((e: unknown) => rethrowAsConflict(e, codeInUse('programme')));
  }

  // ───────── Academic levels ─────────

  listLevels(includeInactive: boolean) {
    return this.prisma.academicLevel.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createLevel(actor: AccessClaims, input: z.output<typeof CreateLevelSchema>, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const level = await tx.academicLevel.create({ data: input });
        await this.audit.record(
          this.entry(actor, 'academic.level.created', 'academic_level', level.id, null, level, context),
          tx,
        );
        return level;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: {
            code: 'CODE_IN_USE',
            message: 'Another level already uses that code or position in the order.',
          },
        }),
      );
  }

  async updateLevel(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateLevelSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const before = await tx.academicLevel.findUnique({ where: { id } });
        if (!before) throw notFound('level');
        const after = await tx.academicLevel.update({ where: { id }, data: input });
        await this.audit.record(
          this.entry(actor, 'academic.level.updated', 'academic_level', id, before, after, context),
          tx,
        );
        return after;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: {
            code: 'CODE_IN_USE',
            message: 'Another level already uses that code or position in the order.',
          },
        }),
      );
  }

  // ───────── Helpers ─────────

  private hasActiveChildren(what: string, count: number, child: string) {
    return new ConflictException({
      code: 'HAS_ACTIVE_CHILDREN',
      message: `This ${what} still has ${count} active ${child}${count === 1 ? '' : 's'}. Deactivate or move them first.`,
    });
  }

  private inactiveParent(what: string) {
    return new BadRequestException({
      code: 'PARENT_INACTIVE',
      message: `The ${what} is inactive. Reactivate it first.`,
    });
  }

  private entry(
    actor: AccessClaims,
    action: string,
    entityType: string,
    entityId: string,
    before: object | null,
    after: object,
    context: RequestContext,
  ) {
    return {
      action,
      entityType,
      entityId,
      actorUserId: actor.userId,
      actorRoleKey: actor.role,
      before: before ? JSON.parse(JSON.stringify(before)) : undefined,
      after: JSON.parse(JSON.stringify(after)),
      context,
    };
  }
}
