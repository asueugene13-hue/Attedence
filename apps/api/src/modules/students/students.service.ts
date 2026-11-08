import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CreateStudent, StudentQuerySchema, UpdateStudentSchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma, StudentStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { AccessClaims } from '../auth/token.service.js';

const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such student.' });
const invalid = (code: string, message: string) => new BadRequestException({ code, message });
const NUMBER_IN_USE = {
  unique: { code: 'STUDENT_NUMBER_IN_USE', message: 'Another student already has that Student ID.' },
};

const studentInclude = {
  user: { select: { id: true, email: true, fullName: true, phone: true, status: true } },
  programme: {
    select: {
      id: true,
      code: true,
      name: true,
      department: {
        select: {
          id: true,
          code: true,
          name: true,
          faculty: { select: { id: true, code: true, name: true } },
        },
      },
    },
  },
  level: { select: { id: true, code: true, name: true } },
  currentAcademicYear: { select: { id: true, label: true } },
  currentSemester: { select: { id: true, name: true, status: true } },
} satisfies Prisma.StudentProfileInclude;

type StudentRow = Prisma.StudentProfileGetPayload<{ include: typeof studentInclude }>;

/** A flat view: faculty and department are derived from the programme, never stored separately. */
export function toStudentView(s: StudentRow) {
  return {
    id: s.id,
    studentNumber: s.studentNumber,
    fullName: s.user.fullName,
    email: s.user.email,
    phone: s.user.phone,
    accountStatus: s.user.status,
    status: s.status,
    programme: { id: s.programme.id, code: s.programme.code, name: s.programme.name },
    department: {
      id: s.programme.department.id,
      code: s.programme.department.code,
      name: s.programme.department.name,
    },
    faculty: s.programme.department.faculty,
    level: s.level,
    academicYear: s.currentAcademicYear,
    semester: s.currentSemester,
    noDeviceExemption: s.noDeviceExemption,
    verifiedAt: s.verifiedAt,
    version: s.version,
    createdAt: s.createdAt,
  };
}

/**
 * Student records, owned by the Registrar. A student is an account holding the STUDENT role plus this
 * profile. Edits are version-checked: two people editing one record cannot overwrite each other.
 */
@Injectable()
export class StudentsService {
  private readonly logger = new Logger(StudentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async list(query: z.output<typeof StudentQuerySchema>) {
    const rows = await this.prisma.studentProfile.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.levelId ? { levelId: query.levelId } : {}),
        ...(query.programmeId ? { programmeId: query.programmeId } : {}),
        // Department and faculty filters combine (both must hold), so they share one `programme` condition.
        ...(query.departmentId || query.facultyId
          ? {
              programme: {
                ...(query.departmentId ? { departmentId: query.departmentId } : {}),
                ...(query.facultyId ? { department: { facultyId: query.facultyId } } : {}),
              },
            }
          : {}),
        ...(query.q
          ? {
              OR: [
                { studentNumber: { contains: query.q } },
                { user: { fullName: { contains: query.q, mode: 'insensitive' } } },
                { user: { email: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: studentInclude,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toStudentView),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(id: string) {
    const row = await this.prisma.studentProfile.findUnique({ where: { id }, include: studentInclude });
    if (!row) throw notFound();
    return toStudentView(row);
  }

  /** The signed-in student's own record, or null for someone who is not a student. */
  async mine(userId: string) {
    const row = await this.prisma.studentProfile.findUnique({ where: { userId }, include: studentInclude });
    return row ? toStudentView(row) : null;
  }

  async create(actor: AccessClaims, input: CreateStudent, context: RequestContext) {
    await this.assertPlacement(input);

    const { profileId, userId, newAccount } = await this.prisma
      .$transaction(async (tx) => {
        let user = await tx.user.findUnique({
          where: { email: input.email },
          include: { studentProfile: true },
        });
        if (user?.studentProfile) {
          throw new ConflictException({
            code: 'ALREADY_STUDENT',
            message: 'This email already belongs to a student.',
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
          data: { email: input.email, fullName: input.fullName, phone: input.phone },
          include: { studentProfile: true },
        });
        const role = await tx.role.findUniqueOrThrow({ where: { key: 'STUDENT' } });
        const holds = await tx.userRole.count({
          where: { userId: user.id, roleId: role.id, revokedAt: null },
        });
        if (holds === 0)
          await tx.userRole.create({ data: { userId: user.id, roleId: role.id, grantedById: actor.userId } });
        const profile = await tx.studentProfile.create({
          data: {
            userId: user.id,
            studentNumber: input.studentNumber,
            programmeId: input.programmeId,
            levelId: input.levelId,
            currentAcademicYearId: input.academicYearId,
            currentSemesterId: input.semesterId,
            status: input.status,
            registeredById: actor.userId,
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'students.registered',
            { type: 'student', id: profile.id },
            { after: { ...profile, email: input.email, newAccount } },
            context,
          ),
          tx,
        );
        return { profileId: profile.id, userId: user.id, newAccount };
      })
      .catch((e: unknown) => rethrowAsConflict(e, NUMBER_IN_USE));

    let activationEmailSent: boolean | null = null;
    if (newAccount) {
      try {
        await this.auth.sendActivationEmail(userId);
        activationEmailSent = true;
      } catch (error) {
        activationEmailSent = false;
        this.logger.error(`Activation email for student ${profileId} failed: ${(error as Error).message}`);
      }
    }
    return { student: await this.get(profileId), newAccount, activationEmailSent };
  }

  async update(
    actor: AccessClaims,
    id: string,
    expectedVersion: number,
    input: z.output<typeof UpdateStudentSchema>,
    context: RequestContext,
  ) {
    const before = await this.prisma.studentProfile.findUnique({ where: { id }, include: studentInclude });
    if (!before) throw notFound();
    await this.assertPlacement({
      programmeId: input.programmeId ?? before.programmeId,
      levelId: input.levelId ?? before.levelId,
      academicYearId: input.academicYearId ?? before.currentAcademicYearId,
      semesterId: input.semesterId ?? before.currentSemesterId,
    });

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.studentProfile.updateMany({
        where: { id, version: expectedVersion },
        data: {
          programmeId: input.programmeId,
          levelId: input.levelId,
          currentAcademicYearId: input.academicYearId,
          currentSemesterId: input.semesterId,
          noDeviceExemption: input.noDeviceExemption,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) throw this.versionConflict(before.version);
      if (input.fullName !== undefined || input.phone !== undefined) {
        await tx.user.update({
          where: { id: before.userId },
          data: { fullName: input.fullName, phone: input.phone },
        });
      }
      const after = await tx.studentProfile.findUniqueOrThrow({ where: { id }, include: studentInclude });
      await this.audit.record(
        auditEntry(
          actor,
          'students.updated',
          { type: 'student', id },
          { before: toStudentView(before), after: toStudentView(after) },
          context,
        ),
        tx,
      );
    });
    return this.get(id);
  }

  async changeStatus(
    actor: AccessClaims,
    id: string,
    expectedVersion: number,
    status: StudentStatus,
    reason: string,
    context: RequestContext,
  ) {
    const before = await this.prisma.studentProfile.findUnique({ where: { id } });
    if (!before) throw notFound();
    if (before.status === status)
      throw new ConflictException({
        code: 'NO_CHANGE',
        message: `The student is already ${status.toLowerCase()}.`,
      });
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.studentProfile.updateMany({
        where: { id, version: expectedVersion },
        data: { status, version: { increment: 1 } },
      });
      if (claimed.count !== 1) throw this.versionConflict(before.version);
      await this.audit.record(
        auditEntry(
          actor,
          'students.status_changed',
          { type: 'student', id },
          { before: { status: before.status }, after: { status }, reason },
          context,
        ),
        tx,
      );
    });
    return this.get(id);
  }

  /** The Registrar confirms the record matches the student's admission documents. */
  async verify(actor: AccessClaims, id: string, expectedVersion: number, context: RequestContext) {
    const before = await this.prisma.studentProfile.findUnique({ where: { id } });
    if (!before) throw notFound();
    if (before.verifiedAt)
      throw new ConflictException({ code: 'ALREADY_VERIFIED', message: 'This record is already verified.' });
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.studentProfile.updateMany({
        where: { id, version: expectedVersion },
        data: { verifiedAt: new Date(), verifiedById: actor.userId, version: { increment: 1 } },
      });
      if (claimed.count !== 1) throw this.versionConflict(before.version);
      await this.audit.record(
        auditEntry(
          actor,
          'students.verified',
          { type: 'student', id },
          { after: { verified: true } },
          context,
        ),
        tx,
      );
    });
    return this.get(id);
  }

  /** Programme (with its department and faculty), level, year and semester must exist, be active and fit together. */
  private async assertPlacement(input: {
    programmeId: string;
    levelId: string;
    academicYearId: string;
    semesterId: string;
    departmentId?: string;
    facultyId?: string;
  }) {
    const programme = await this.prisma.programme.findUnique({
      where: { id: input.programmeId },
      include: { department: { include: { faculty: true } } },
    });
    if (!programme?.isActive || !programme.department.isActive || !programme.department.faculty.isActive) {
      throw invalid('INVALID_PROGRAMME', 'No such active programme.');
    }
    if (input.departmentId && input.departmentId !== programme.departmentId) {
      throw invalid('PLACEMENT_MISMATCH', 'That programme belongs to a different department.');
    }
    if (input.facultyId && input.facultyId !== programme.department.facultyId) {
      throw invalid('PLACEMENT_MISMATCH', 'That programme belongs to a different faculty.');
    }
    const level = await this.prisma.academicLevel.findUnique({ where: { id: input.levelId } });
    if (!level?.isActive) throw invalid('INVALID_LEVEL', 'No such active level.');
    const semester = await this.prisma.semester.findUnique({ where: { id: input.semesterId } });
    if (!semester || semester.academicYearId !== input.academicYearId) {
      throw invalid('PLACEMENT_MISMATCH', 'That semester does not belong to that academic year.');
    }
    if (semester.status === 'CLOSED') throw invalid('SEMESTER_CLOSED', 'That semester is closed.');
  }

  private versionConflict(current: number) {
    return new ConflictException({
      code: 'VERSION_CONFLICT',
      message: 'Someone else changed this record since you opened it. Reload it and try again.',
      errors: { currentVersion: current },
    });
  }
}
