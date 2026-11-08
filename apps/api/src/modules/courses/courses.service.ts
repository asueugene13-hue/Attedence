import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateCourseSchema,
  CreateOfferingSchema,
  CreateSectionSchema,
  UpdateCourseSchema,
  UpdateSectionSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { OfferingStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';

const notFound = (what: string) => new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });
const conflict = (code: string, message: string) => new ConflictException({ code, message });

/** Sections with their programme/level hints and active lecturers, for list and detail views. */
const sectionInclude = {
  programme: { select: { id: true, code: true, name: true } },
  level: { select: { id: true, code: true, name: true } },
  assignments: {
    where: { endedAt: null },
    orderBy: { assignedAt: 'asc' },
    select: {
      id: true,
      isPrimary: true,
      assignedAt: true,
      lecturer: {
        select: { id: true, staffNumber: true, title: true, user: { select: { fullName: true } } },
      },
    },
  },
} satisfies Prisma.CourseSectionInclude;

/**
 * Courses (owned by a department), offerings (a course in a semester: DRAFT → OPEN → CLOSED) and
 * sections (class groups within an offering). Administrators act only within their department or
 * faculty scope; the course's department decides.
 */
@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
  ) {}

  // ───────── Courses ─────────

  listCourses(filter: { includeInactive: boolean; q?: string; departmentId?: string; facultyId?: string }) {
    return this.prisma.course.findMany({
      where: {
        ...(filter.includeInactive ? {} : { isActive: true }),
        ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
        ...(filter.facultyId ? { department: { facultyId: filter.facultyId } } : {}),
        ...(filter.q
          ? {
              OR: [
                { code: { contains: filter.q, mode: 'insensitive' } },
                { title: { contains: filter.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { code: 'asc' },
      include: { department: { select: { id: true, code: true, name: true, facultyId: true } } },
    });
  }

  async createCourse(
    actor: AccessClaims,
    input: z.output<typeof CreateCourseSchema>,
    context: RequestContext,
  ) {
    const department = await this.prisma.department.findUnique({ where: { id: input.departmentId } });
    if (!department) throw notFound('department');
    await this.access.assertDepartment(actor, department);
    if (!department.isActive)
      throw new BadRequestException({ code: 'PARENT_INACTIVE', message: 'The department is inactive.' });
    return this.prisma
      .$transaction(async (tx) => {
        const course = await tx.course.create({ data: input });
        await this.audit.record(
          auditEntry(
            actor,
            'courses.course.created',
            { type: 'course', id: course.id },
            { after: course },
            context,
          ),
          tx,
        );
        return course;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: { code: 'CODE_IN_USE', message: 'Another course already uses that code.' },
        }),
      );
  }

  async updateCourse(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateCourseSchema>,
    context: RequestContext,
  ) {
    const before = await this.prisma.course.findUnique({ where: { id }, include: { department: true } });
    if (!before) throw notFound('course');
    await this.access.assertDepartment(actor, before.department);
    return this.prisma
      .$transaction(async (tx) => {
        if (input.isActive === false && before.isActive) {
          const open = await tx.courseOffering.count({ where: { courseId: id, status: 'OPEN' } });
          if (open > 0)
            throw conflict(
              'HAS_OPEN_OFFERINGS',
              'This course is running this semester. Close its offerings first.',
            );
        }
        const after = await tx.course.update({ where: { id }, data: input });
        const { department: _d, ...beforeRow } = before;
        await this.audit.record(
          auditEntry(
            actor,
            'courses.course.updated',
            { type: 'course', id },
            { before: beforeRow, after },
            context,
          ),
          tx,
        );
        return after;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: { code: 'CODE_IN_USE', message: 'Another course already uses that code.' },
        }),
      );
  }

  // ───────── Offerings ─────────

  listOfferings(filter: { semesterId?: string; courseId?: string; departmentId?: string; status?: string }) {
    return this.prisma.courseOffering.findMany({
      where: {
        ...(filter.semesterId ? { semesterId: filter.semesterId } : {}),
        ...(filter.courseId ? { courseId: filter.courseId } : {}),
        ...(filter.departmentId ? { course: { departmentId: filter.departmentId } } : {}),
        ...(filter.status && ['DRAFT', 'OPEN', 'CLOSED'].includes(filter.status)
          ? { status: filter.status as OfferingStatus }
          : {}),
      },
      orderBy: [{ course: { code: 'asc' } }],
      include: {
        course: { select: { id: true, code: true, title: true, departmentId: true } },
        semester: {
          select: { id: true, name: true, status: true, academicYear: { select: { label: true } } },
        },
        sections: { orderBy: { code: 'asc' }, include: sectionInclude },
      },
    });
  }

  async createOffering(
    actor: AccessClaims,
    input: z.output<typeof CreateOfferingSchema>,
    context: RequestContext,
  ) {
    const course = await this.prisma.course.findUnique({
      where: { id: input.courseId },
      include: { department: true },
    });
    if (!course) throw notFound('course');
    await this.access.assertDepartment(actor, course.department);
    if (!course.isActive)
      throw new BadRequestException({ code: 'PARENT_INACTIVE', message: 'The course is inactive.' });
    const semester = await this.prisma.semester.findUnique({ where: { id: input.semesterId } });
    if (!semester) throw notFound('semester');
    if (semester.status === 'CLOSED') throw conflict('SEMESTER_CLOSED', 'That semester is closed.');
    return this.prisma
      .$transaction(async (tx) => {
        const offering = await tx.courseOffering.create({ data: input });
        await this.audit.record(
          auditEntry(
            actor,
            'courses.offering.created',
            { type: 'course_offering', id: offering.id },
            { after: offering },
            context,
          ),
          tx,
        );
        return offering;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: { code: 'ALREADY_OFFERED', message: 'This course is already offered in that semester.' },
        }),
      );
  }

  /** DRAFT → OPEN (students can be enrolled; classes can be timetabled) → CLOSED. */
  async setOfferingStatus(actor: AccessClaims, id: string, to: 'OPEN' | 'CLOSED', context: RequestContext) {
    const offering = await this.prisma.courseOffering.findUnique({
      where: { id },
      include: { course: { include: { department: true } }, semester: true },
    });
    if (!offering) throw notFound('course offering');
    await this.access.assertDepartment(actor, offering.course.department);
    const allowed = to === 'OPEN' ? offering.status === 'DRAFT' : offering.status !== 'CLOSED';
    if (!allowed)
      throw conflict(
        'INVALID_TRANSITION',
        `An offering that is ${offering.status.toLowerCase()} cannot become ${to.toLowerCase()}.`,
      );
    if (to === 'OPEN' && offering.semester.status === 'CLOSED')
      throw conflict('SEMESTER_CLOSED', 'That semester is closed.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.courseOffering.updateMany({
        where: { id, status: offering.status },
        data: { status: to },
      });
      if (updated.count !== 1)
        throw conflict('CHANGED_MEANWHILE', 'Someone else changed this offering. Reload and try again.');
      await this.audit.record(
        auditEntry(
          actor,
          `courses.offering.${to === 'OPEN' ? 'opened' : 'closed'}`,
          { type: 'course_offering', id },
          { before: { status: offering.status }, after: { status: to } },
          context,
        ),
        tx,
      );
      return tx.courseOffering.findUniqueOrThrow({ where: { id } });
    });
  }

  // ───────── Sections ─────────

  async createSection(
    actor: AccessClaims,
    input: z.output<typeof CreateSectionSchema>,
    context: RequestContext,
  ) {
    const offering = await this.offeringForChange(actor, input.offeringId);
    await this.assertHints(input.programmeId, input.levelId);
    return this.prisma
      .$transaction(async (tx) => {
        const section = await tx.courseSection.create({ data: input });
        await this.audit.record(
          auditEntry(
            actor,
            'courses.section.created',
            { type: 'course_section', id: section.id },
            { after: { ...section, offeringStatus: offering.status } },
            context,
          ),
          tx,
        );
        return section;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: { code: 'CODE_IN_USE', message: 'This offering already has a section with that code.' },
        }),
      );
  }

  async updateSection(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateSectionSchema>,
    context: RequestContext,
  ) {
    const before = await this.prisma.courseSection.findUnique({ where: { id } });
    if (!before) throw notFound('section');
    await this.offeringForChange(actor, before.offeringId);
    await this.assertHints(input.programmeId ?? undefined, input.levelId ?? undefined);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.courseSection.update({ where: { id }, data: input });
      await this.audit.record(
        auditEntry(
          actor,
          'courses.section.updated',
          { type: 'course_section', id },
          { before, after },
          context,
        ),
        tx,
      );
      return after;
    });
  }

  /** The offering a section belongs to, after checking scope and that it is still open for changes. */
  private async offeringForChange(actor: AccessClaims, offeringId: string) {
    const offering = await this.prisma.courseOffering.findUnique({
      where: { id: offeringId },
      include: { course: { include: { department: true } } },
    });
    if (!offering) throw notFound('course offering');
    await this.access.assertDepartment(actor, offering.course.department);
    if (offering.status === 'CLOSED') throw conflict('OFFERING_CLOSED', 'This offering is closed.');
    return offering;
  }

  private async assertHints(programmeId?: string, levelId?: string) {
    if (programmeId) {
      const programme = await this.prisma.programme.findUnique({ where: { id: programmeId } });
      if (!programme?.isActive)
        throw new BadRequestException({ code: 'INVALID_PROGRAMME', message: 'No such active programme.' });
    }
    if (levelId) {
      const level = await this.prisma.academicLevel.findUnique({ where: { id: levelId } });
      if (!level?.isActive)
        throw new BadRequestException({ code: 'INVALID_LEVEL', message: 'No such active level.' });
    }
  }
}

export { sectionInclude };
