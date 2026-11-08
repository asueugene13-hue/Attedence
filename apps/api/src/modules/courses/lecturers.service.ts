import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CreateLecturerSchema, UpdateLecturerSchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { AccessClaims } from '../auth/token.service.js';

const notFound = (what: string) => new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });
const STAFF_NUMBER_IN_USE = {
  unique: { code: 'STAFF_NUMBER_IN_USE', message: 'Another lecturer already has that staff number.' },
};

const profileInclude = {
  user: { select: { id: true, email: true, fullName: true, status: true } },
  department: { select: { id: true, code: true, name: true, facultyId: true } },
} satisfies Prisma.LecturerProfileInclude;

/**
 * Lecturer profiles and lecturer-to-section assignments. A lecturer is an ordinary account holding the
 * LECTURER role plus this profile; someone who already has an account (an administrator who also
 * teaches) gets the profile and role added rather than a second account.
 */
@Injectable()
export class LecturersService {
  private readonly logger = new Logger(LecturersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
    private readonly auth: AuthService,
  ) {}

  listLecturers(filter: { q?: string; departmentId?: string; facultyId?: string; status?: string }) {
    return this.prisma.lecturerProfile.findMany({
      where: {
        ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
        ...(filter.facultyId ? { department: { facultyId: filter.facultyId } } : {}),
        ...(filter.status && ['ACTIVE', 'ON_LEAVE', 'INACTIVE'].includes(filter.status)
          ? { status: filter.status as 'ACTIVE' | 'ON_LEAVE' | 'INACTIVE' }
          : {}),
        ...(filter.q
          ? {
              OR: [
                { staffNumber: { contains: filter.q, mode: 'insensitive' } },
                { user: { fullName: { contains: filter.q, mode: 'insensitive' } } },
                { user: { email: { contains: filter.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      orderBy: { user: { fullName: 'asc' } },
      include: profileInclude,
    });
  }

  async getLecturer(id: string) {
    const profile = await this.prisma.lecturerProfile.findUnique({
      where: { id },
      include: {
        ...profileInclude,
        assignments: {
          where: { endedAt: null },
          include: {
            section: {
              include: {
                offering: {
                  include: {
                    course: { select: { code: true, title: true } },
                    semester: { select: { name: true, status: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!profile) throw notFound('lecturer');
    return profile;
  }

  async createLecturer(
    actor: AccessClaims,
    input: z.output<typeof CreateLecturerSchema>,
    context: RequestContext,
  ) {
    const department = await this.prisma.department.findUnique({ where: { id: input.departmentId } });
    if (!department) throw notFound('department');
    await this.access.assertDepartment(actor, department);
    if (!department.isActive)
      throw new BadRequestException({ code: 'PARENT_INACTIVE', message: 'The department is inactive.' });

    const { profile, newAccount } = await this.prisma
      .$transaction(async (tx) => {
        let user = await tx.user.findUnique({
          where: { email: input.email },
          include: { lecturerProfile: true },
        });
        if (user?.lecturerProfile) {
          throw new ConflictException({
            code: 'ALREADY_LECTURER',
            message: 'This person already has a lecturer profile.',
          });
        }
        if (user?.status === 'DEACTIVATED') {
          throw new ConflictException({
            code: 'ACCOUNT_DEACTIVATED',
            message: 'That account is deactivated.',
          });
        }
        const newAccount = !user;
        user ??= await tx.user.create({
          data: { email: input.email, fullName: input.fullName },
          include: { lecturerProfile: true },
        });
        const role = await tx.role.findUniqueOrThrow({ where: { key: 'LECTURER' } });
        const holds = await tx.userRole.count({
          where: { userId: user.id, roleId: role.id, revokedAt: null },
        });
        if (holds === 0)
          await tx.userRole.create({ data: { userId: user.id, roleId: role.id, grantedById: actor.userId } });
        const profile = await tx.lecturerProfile.create({
          data: {
            userId: user.id,
            staffNumber: input.staffNumber,
            departmentId: input.departmentId,
            title: input.title,
          },
          include: profileInclude,
        });
        await this.audit.record(
          auditEntry(
            actor,
            'lecturers.created',
            { type: 'lecturer_profile', id: profile.id },
            { after: { ...profile, newAccount } },
            context,
          ),
          tx,
        );
        return { profile, newAccount };
      })
      .catch((e: unknown) => rethrowAsConflict(e, STAFF_NUMBER_IN_USE));

    let activationEmailSent: boolean | null = null;
    if (newAccount) {
      try {
        await this.auth.sendActivationEmail(profile.userId);
        activationEmailSent = true;
      } catch (error) {
        activationEmailSent = false;
        this.logger.error(`Activation email for lecturer ${profile.id} failed: ${(error as Error).message}`);
      }
    }
    return { lecturer: profile, newAccount, activationEmailSent };
  }

  async updateLecturer(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateLecturerSchema>,
    context: RequestContext,
  ) {
    const before = await this.prisma.lecturerProfile.findUnique({
      where: { id },
      include: { department: true },
    });
    if (!before) throw notFound('lecturer');
    await this.access.assertDepartment(actor, before.department);
    if (input.departmentId && input.departmentId !== before.departmentId) {
      const target = await this.prisma.department.findUnique({ where: { id: input.departmentId } });
      if (!target?.isActive)
        throw new BadRequestException({ code: 'INVALID_DEPARTMENT', message: 'No such active department.' });
      await this.access.assertDepartment(actor, target);
    }
    return this.prisma
      .$transaction(async (tx) => {
        const after = await tx.lecturerProfile.update({
          where: { id },
          data: input,
          include: profileInclude,
        });
        const { department: _d, ...beforeRow } = before;
        await this.audit.record(
          auditEntry(
            actor,
            'lecturers.updated',
            { type: 'lecturer_profile', id },
            { before: beforeRow, after },
            context,
          ),
          tx,
        );
        return after;
      })
      .catch((e: unknown) => rethrowAsConflict(e, STAFF_NUMBER_IN_USE));
  }

  // ───────── Assignments ─────────

  async assign(
    actor: AccessClaims,
    sectionId: string,
    input: { lecturerId: string; isPrimary: boolean },
    context: RequestContext,
  ) {
    const section = await this.sectionForChange(actor, sectionId);
    const lecturer = await this.prisma.lecturerProfile.findUnique({
      where: { id: input.lecturerId },
      include: { user: true },
    });
    if (!lecturer) throw notFound('lecturer');
    if (
      lecturer.status === 'INACTIVE' ||
      lecturer.user.status === 'DEACTIVATED' ||
      lecturer.user.status === 'SUSPENDED'
    ) {
      throw new ConflictException({ code: 'LECTURER_UNAVAILABLE', message: 'This lecturer is not active.' });
    }
    return this.prisma
      .$transaction(async (tx) => {
        const assignment = await tx.lecturerAssignment.create({
          data: {
            lecturerId: lecturer.id,
            sectionId,
            isPrimary: input.isPrimary,
            assignedById: actor.userId,
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'lecturers.assigned',
            { type: 'lecturer_assignment', id: assignment.id },
            {
              after: { ...assignment, sectionCode: section.code, staffNumber: lecturer.staffNumber },
            },
            context,
          ),
          tx,
        );
        return assignment;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          lecturer_assignments_active_unique: {
            code: 'ALREADY_ASSIGNED',
            message: 'This lecturer is already assigned to this section.',
          },
          lecturer_assignments_one_primary: {
            code: 'PRIMARY_EXISTS',
            message:
              'This section already has a primary lecturer. Add this lecturer as an assistant, or end the current primary assignment first.',
          },
        }),
      );
  }

  /** Ends an assignment; the record stays for history. */
  async endAssignment(
    actor: AccessClaims,
    sectionId: string,
    assignmentId: string,
    reason: string,
    context: RequestContext,
  ) {
    await this.sectionForChange(actor, sectionId, { allowClosed: true });
    return this.prisma.$transaction(async (tx) => {
      const ended = await tx.lecturerAssignment.updateMany({
        where: { id: assignmentId, sectionId, endedAt: null },
        data: { endedAt: new Date(), endedById: actor.userId },
      });
      if (ended.count !== 1) throw notFound('active assignment');
      await this.audit.record(
        auditEntry(
          actor,
          'lecturers.assignment_ended',
          { type: 'lecturer_assignment', id: assignmentId },
          { after: { sectionId }, reason },
          context,
        ),
        tx,
      );
    });
  }

  /** Whether this person currently teaches the section (an active assignment). */
  async teaches(userId: string, sectionId: string): Promise<boolean> {
    const count = await this.prisma.lecturerAssignment.count({
      where: { sectionId, endedAt: null, lecturer: { userId } },
    });
    return count > 0;
  }

  /** The signed-in lecturer's current class groups. */
  async myTeaching(userId: string) {
    const profile = await this.prisma.lecturerProfile.findUnique({ where: { userId } });
    if (!profile) return { lecturer: null, sections: [] };
    const assignments = await this.prisma.lecturerAssignment.findMany({
      where: {
        lecturerId: profile.id,
        endedAt: null,
        section: { isActive: true, offering: { status: { not: 'CLOSED' } } },
      },
      include: {
        section: {
          include: {
            offering: {
              include: {
                course: { select: { code: true, title: true } },
                semester: { select: { id: true, name: true, status: true } },
              },
            },
          },
        },
      },
      orderBy: { assignedAt: 'asc' },
    });
    return {
      lecturer: { id: profile.id, staffNumber: profile.staffNumber },
      sections: assignments.map((a) => ({
        assignmentId: a.id,
        isPrimary: a.isPrimary,
        sectionId: a.section.id,
        sectionCode: a.section.code,
        course: a.section.offering.course,
        offering: { id: a.section.offering.id, status: a.section.offering.status },
        semester: a.section.offering.semester,
      })),
    };
  }

  private async sectionForChange(
    actor: AccessClaims,
    sectionId: string,
    options: { allowClosed?: boolean } = {},
  ) {
    const section = await this.prisma.courseSection.findUnique({
      where: { id: sectionId },
      include: { offering: { include: { course: { include: { department: true } } } } },
    });
    if (!section) throw notFound('section');
    await this.access.assertDepartment(actor, section.offering.course.department);
    if (!options.allowClosed && (section.offering.status === 'CLOSED' || !section.isActive)) {
      throw new ConflictException({
        code: 'SECTION_UNAVAILABLE',
        message: 'This section is closed or inactive.',
      });
    }
    return section;
  }
}
