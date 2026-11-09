import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { EnrollmentQuerySchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { CourseEnrollment, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { CoursesService, type SectionFacts } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { StudentsService } from '../students/students.service.js';

type Tx = Prisma.TransactionClient;

const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such enrolment.' });
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const ALREADY_ENROLLED = {
  course_enrollments_active_unique: {
    code: 'ALREADY_ENROLLED',
    message: 'This student is already enrolled in this course offering (in this or another section).',
  },
};

/** Reasons an enrolment cannot be made, shared by single enrolment and import checks. */
export function enrolmentBlocker(
  student: { status: string } | undefined,
  section: SectionFacts | null | undefined,
): { code: string; message: string } | null {
  if (!student) return { code: 'UNKNOWN_STUDENT', message: 'No student has that ID.' };
  if (student.status !== 'ACTIVE') {
    return {
      code: 'STUDENT_NOT_ACTIVE',
      message: `The student's status is ${student.status.toLowerCase()}.`,
    };
  }
  if (!section) return { code: 'UNKNOWN_SECTION', message: 'No such section.' };
  if (!section.isActive) return { code: 'SECTION_INACTIVE', message: 'That section is not active.' };
  if (section.offeringStatus === 'CLOSED' || section.semester.status === 'CLOSED') {
    return { code: 'OFFERING_CLOSED', message: 'That course offering or its semester is closed.' };
  }
  return null;
}

/**
 * Enrolments: which students belong to which section. Owned by the Registrar. A student holds at most
 * one active enrolment per offering; ending one needs a reason and keeps the record. Section capacity
 * is enforced under a row lock, so simultaneous enrolments cannot overfill a section.
 */
@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
    private readonly permissions: PermissionService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly students: StudentsService,
  ) {}

  async enroll(
    actor: AccessClaims,
    input: { studentId: string; sectionId: string },
    context: RequestContext,
  ) {
    const enrolment = await this.prisma
      .$transaction((tx) => this.enrollInTx(tx, actor, input, context))
      .catch((e: unknown) => rethrowAsConflict(e, ALREADY_ENROLLED));
    return this.get(enrolment.id);
  }

  /** One enrolment inside the caller's transaction. Used by single enrolment and by import. */
  async enrollInTx(
    tx: Tx,
    actor: AccessClaims,
    input: { studentId: string; sectionId: string },
    context: RequestContext,
    extra: { importBatchId?: string; importRowNumber?: number } = {},
  ) {
    await this.courses.lockSection(tx, input.sectionId);
    const section = await this.courses.sectionFacts(input.sectionId, tx);
    const student = (await this.students.summaries([input.studentId])).get(input.studentId);
    const blocked = enrolmentBlocker(student, section);
    if (blocked) {
      if (blocked.code === 'UNKNOWN_STUDENT' || blocked.code === 'UNKNOWN_SECTION') {
        throw new NotFoundException(blocked);
      }
      throw new ConflictException(blocked);
    }
    if (section!.capacity !== null) {
      const taken = await tx.courseEnrollment.count({
        where: { sectionId: section!.id, status: 'ENROLLED' },
      });
      if (taken >= section!.capacity) {
        throw conflict('SECTION_FULL', `Section ${section!.code} is full (${section!.capacity} places).`);
      }
    }
    const enrolment = await tx.courseEnrollment.create({
      data: {
        studentId: input.studentId,
        offeringId: section!.offeringId,
        sectionId: section!.id,
        createdById: actor.userId,
        importBatchId: extra.importBatchId,
      },
    });
    await this.audit.record(
      auditEntry(
        actor,
        'enrollments.created',
        { type: 'enrollment', id: enrolment.id },
        {
          after: {
            ...enrolment,
            studentNumber: student!.studentNumber,
            course: section!.course.code,
            section: section!.code,
            ...extra,
          },
        },
        context,
      ),
      tx,
    );
    return enrolment;
  }

  /**
   * Drops or withdraws an enrolment, with a reason. The record stays. Any course-rep nomination or
   * appointment the student holds for that section ends with it, because a rep must be enrolled.
   */
  async end(
    actor: AccessClaims,
    id: string,
    input: { status: 'DROPPED' | 'WITHDRAWN'; reason: string },
    context: RequestContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.courseEnrollment.findUnique({ where: { id } });
      if (!before) throw notFound();
      const claimed = await tx.courseEnrollment.updateMany({
        where: { id, status: 'ENROLLED' },
        data: { status: input.status, endedAt: new Date(), endedById: actor.userId, endReason: input.reason },
      });
      if (claimed.count !== 1) throw conflict('NOT_ENROLLED', 'This enrolment has already ended.');
      await this.audit.record(
        auditEntry(
          actor,
          'enrollments.ended',
          { type: 'enrollment', id },
          { before: { status: before.status }, after: { status: input.status }, reason: input.reason },
          context,
        ),
        tx,
      );
      const reps = await tx.courseRepAssignment.findMany({
        where: {
          studentId: before.studentId,
          sectionId: before.sectionId,
          status: { in: ['NOMINATED', 'ACTIVE'] },
        },
      });
      for (const rep of reps) {
        const endReason = `Enrolment ${input.status.toLowerCase()}: ${input.reason}`;
        await tx.courseRepAssignment.update({
          where: { id: rep.id },
          data: {
            status: rep.status === 'ACTIVE' ? 'ENDED' : 'REJECTED',
            endedAt: new Date(),
            endedById: actor.userId,
            endReason,
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'course_reps.ended',
            { type: 'course_rep', id: rep.id },
            {
              before: { status: rep.status },
              after: { status: rep.status === 'ACTIVE' ? 'ENDED' : 'REJECTED' },
              reason: endReason,
            },
            context,
          ),
          tx,
        );
      }
    });
    return this.get(id);
  }

  async get(id: string) {
    const row = await this.prisma.courseEnrollment.findUnique({ where: { id } });
    if (!row) throw notFound();
    return (await this.views([row]))[0]!;
  }

  async list(query: z.output<typeof EnrollmentQuerySchema>) {
    const rows = await this.prisma.courseEnrollment.findMany({
      where: {
        ...(query.sectionId ? { sectionId: query.sectionId } : {}),
        ...(query.offeringId ? { offeringId: query.offeringId } : {}),
        ...(query.studentId ? { studentId: query.studentId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: await this.views(page),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * The students currently enrolled in a section. Open to staff who manage enrolments and to the
   * section's own lecturers; anyone else is refused.
   */
  async roster(actor: AccessClaims, sectionId: string) {
    const section = await this.courses.sectionFacts(sectionId);
    if (!section) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such section.' });
    const held = await this.permissions.forRole(actor.role);
    let mayRead =
      held.has('enrollments.manage') ||
      (actor.role === 'LECTURER' && (await this.lecturers.teaches(actor.userId, sectionId)));
    // Administrators who appoint course reps choose from the enrolled students, within their own scope.
    if (!mayRead && held.has('course_reps.assign')) {
      await this.access.assertDepartment(actor, section.department);
      mayRead = true;
    }
    if (!mayRead) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message:
          'Only the lecturers of this section, enrolment staff and course-rep administrators can see its students.',
      });
    }
    const rows = await this.prisma.courseEnrollment.findMany({
      where: { sectionId, status: 'ENROLLED' },
      orderBy: { enrolledAt: 'asc' },
    });
    const students = await this.students.summaries(rows.map((r) => r.studentId));
    return {
      section: { id: section.id, code: section.code, capacity: section.capacity, course: section.course },
      enrolledCount: rows.length,
      students: rows
        .map((r) => {
          const s = students.get(r.studentId)!;
          return {
            enrollmentId: r.id,
            studentId: r.studentId,
            studentNumber: s.studentNumber,
            fullName: s.fullName,
            programme: s.programme,
            level: s.level,
            enrolledAt: r.enrolledAt,
          };
        })
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  }

  /** The signed-in student's own enrolments. */
  async mine(userId: string) {
    const studentId = await this.students.idForUser(userId);
    if (!studentId) return { enrollments: [] };
    const rows = await this.prisma.courseEnrollment.findMany({
      where: { studentId },
      orderBy: { enrolledAt: 'desc' },
    });
    return { enrollments: await this.views(rows) };
  }

  /** Whether the student currently holds an enrolment in the section (used by course reps). */
  /** Currently enrolled students per section, for timetable clash warnings and room-size checks. */
  async enrolledBySection(sectionIds: string[]): Promise<Map<string, string[]>> {
    const rows = await this.prisma.courseEnrollment.findMany({
      where: { sectionId: { in: [...new Set(sectionIds)] }, status: 'ENROLLED' },
      select: { sectionId: true, studentId: true },
    });
    const bySection = new Map<string, string[]>();
    for (const r of rows) bySection.set(r.sectionId, [...(bySection.get(r.sectionId) ?? []), r.studentId]);
    return bySection;
  }

  async isEnrolled(studentId: string, sectionId: string, tx: Tx = this.prisma): Promise<boolean> {
    return (await tx.courseEnrollment.count({ where: { studentId, sectionId, status: 'ENROLLED' } })) > 0;
  }

  private async views(rows: CourseEnrollment[]) {
    const [students, sections] = await Promise.all([
      this.students.summaries(rows.map((r) => r.studentId)),
      this.courses.sectionSummaries(rows.map((r) => r.sectionId)),
    ]);
    return rows.map((r) => {
      const student = students.get(r.studentId)!;
      const section = sections.get(r.sectionId)!;
      return {
        id: r.id,
        status: r.status,
        enrolledAt: r.enrolledAt,
        endedAt: r.endedAt,
        endReason: r.endReason,
        student: { id: student.id, studentNumber: student.studentNumber, fullName: student.fullName },
        section: { id: section.id, code: section.code },
        course: section.course,
        semester: section.semester,
        offeringId: r.offeringId,
      };
    });
  }
}
