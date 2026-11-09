import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import type { CourseRepAssignment, CourseRepStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { StudentsService } from '../students/students.service.js';
import { EnrollmentsService } from './enrollments.service.js';

const notFound = (what = 'course-rep assignment') =>
  new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const ALREADY_OPEN = {
  course_rep_assignments_open_unique: {
    code: 'ALREADY_REP',
    message: 'This student is already a course rep, or already nominated, for this section.',
  },
};

/**
 * Course representatives (decision D-12): an administrator appoints, within their faculty or department
 * scope; a lecturer of the section may nominate, and an administrator approves or rejects. A rep must be
 * enrolled in the section, and the role only counts while the section's semester is open.
 * Reps keep their Student role; rep tools (Phase 3 onward) check for an active assignment.
 */
@Injectable()
export class CourseRepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
    private readonly permissions: PermissionService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly students: StudentsService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  async appoint(
    actor: AccessClaims,
    sectionId: string,
    input: { studentId: string; reason?: string },
    context: RequestContext,
  ) {
    const section = await this.openSection(sectionId);
    await this.access.assertDepartment(actor, section.department);
    await this.assertEnrolled(input.studentId, sectionId);
    const rep = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.courseRepAssignment.create({
          data: {
            studentId: input.studentId,
            sectionId,
            status: 'ACTIVE',
            assignedById: actor.userId,
            startsAt: new Date(),
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'course_reps.appointed',
            { type: 'course_rep', id: created.id },
            { after: created, reason: input.reason },
            context,
          ),
          tx,
        );
        return created;
      })
      .catch((e: unknown) => rethrowAsConflict(e, ALREADY_OPEN));
    return this.get(rep.id);
  }

  /** A lecturer proposes one of their own students; nothing changes until an administrator approves. */
  async nominate(
    actor: AccessClaims,
    sectionId: string,
    input: { studentId: string; note?: string },
    context: RequestContext,
  ) {
    await this.openSection(sectionId);
    if (!(await this.lecturers.teaches(actor.userId, sectionId))) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_SECTION',
        message: 'You can only nominate reps for sections you teach.',
      });
    }
    await this.assertEnrolled(input.studentId, sectionId);
    const rep = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.courseRepAssignment.create({
          data: {
            studentId: input.studentId,
            sectionId,
            status: 'NOMINATED',
            nominatedById: actor.userId,
            nominationNote: input.note,
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'course_reps.nominated',
            { type: 'course_rep', id: created.id },
            { after: created },
            context,
          ),
          tx,
        );
        return created;
      })
      .catch((e: unknown) => rethrowAsConflict(e, ALREADY_OPEN));
    return this.get(rep.id);
  }

  async approve(actor: AccessClaims, id: string, context: RequestContext) {
    const rep = await this.forDecision(actor, id);
    await this.assertEnrolled(rep.studentId, rep.sectionId);
    await this.transition(
      actor,
      rep,
      'NOMINATED',
      { status: 'ACTIVE', assignedById: actor.userId, startsAt: new Date() },
      'course_reps.approved',
      undefined,
      context,
    );
    return this.get(id);
  }

  async reject(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    const rep = await this.forDecision(actor, id);
    await this.transition(
      actor,
      rep,
      'NOMINATED',
      { status: 'REJECTED', endedAt: new Date(), endedById: actor.userId, endReason: reason },
      'course_reps.rejected',
      reason,
      context,
    );
    return this.get(id);
  }

  async end(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    const rep = await this.forDecision(actor, id);
    await this.transition(
      actor,
      rep,
      'ACTIVE',
      { status: 'ENDED', endedAt: new Date(), endedById: actor.userId, endReason: reason },
      'course_reps.ended',
      reason,
      context,
    );
    return this.get(id);
  }

  /** A section's reps and nominations: for administrators within scope and the section's lecturers. */
  async listForSection(actor: AccessClaims, sectionId: string) {
    const section = await this.courses.sectionFacts(sectionId);
    if (!section) throw notFound('section');
    const held = await this.permissions.forRole(actor.role);
    if (held.has('course_reps.assign')) {
      await this.access.assertDepartment(actor, section.department);
    } else if (!(actor.role === 'LECTURER' && (await this.lecturers.teaches(actor.userId, sectionId)))) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to do this.',
      });
    }
    const rows = await this.prisma.courseRepAssignment.findMany({
      where: { sectionId },
      orderBy: { createdAt: 'desc' },
    });
    return { data: await this.views(rows) };
  }

  /** The signed-in student's current rep roles. A rep role counts only while its semester is open. */
  async mine(userId: string) {
    const studentId = await this.students.idForUser(userId);
    if (!studentId) return { courseReps: [] };
    const rows = await this.prisma.courseRepAssignment.findMany({ where: { studentId, status: 'ACTIVE' } });
    const views = await this.views(rows);
    return { courseReps: views.filter((v) => v.semester.status !== 'CLOSED') };
  }

  /** Students who are active course reps of any of these sections. */
  async activeRepStudentIds(sectionIds: string[]): Promise<string[]> {
    const rows = await this.prisma.courseRepAssignment.findMany({
      where: { status: 'ACTIVE', sectionId: { in: sectionIds } },
      select: { studentId: true },
    });
    return [...new Set(rows.map((r) => r.studentId))];
  }

  /** Of these sections, the ones the student is the active course rep of (for class issue reports). */
  async activeRepSectionIds(studentId: string, sectionIds: string[]): Promise<string[]> {
    const rows = await this.prisma.courseRepAssignment.findMany({
      where: { studentId, status: 'ACTIVE', sectionId: { in: sectionIds } },
      select: { sectionId: true },
    });
    return rows.map((r) => r.sectionId);
  }

  async get(id: string) {
    const row = await this.prisma.courseRepAssignment.findUnique({ where: { id } });
    if (!row) throw notFound();
    return (await this.views([row]))[0]!;
  }

  private async openSection(sectionId: string) {
    const section = await this.courses.sectionFacts(sectionId);
    if (!section) throw notFound('section');
    if (!section.isActive || section.offeringStatus === 'CLOSED' || section.semester.status === 'CLOSED') {
      throw conflict('OFFERING_CLOSED', 'That section, its course offering or its semester is closed.');
    }
    return section;
  }

  private async assertEnrolled(studentId: string, sectionId: string) {
    if (!(await this.enrollments.isEnrolled(studentId, sectionId))) {
      throw conflict('NOT_ENROLLED', 'A course rep must be enrolled in the section they represent.');
    }
  }

  /** Loads an assignment and checks the administrator's scope over its section. */
  private async forDecision(actor: AccessClaims, id: string) {
    const rep = await this.prisma.courseRepAssignment.findUnique({ where: { id } });
    if (!rep) throw notFound();
    const section = await this.courses.sectionFacts(rep.sectionId);
    await this.access.assertDepartment(actor, section!.department);
    return rep;
  }

  /** Moves an assignment from one status to another only if nobody changed it first. */
  private async transition(
    actor: AccessClaims,
    rep: CourseRepAssignment,
    from: CourseRepStatus,
    data: Partial<
      Pick<
        CourseRepAssignment,
        'status' | 'assignedById' | 'startsAt' | 'endedAt' | 'endedById' | 'endReason'
      >
    >,
    action: string,
    reason: string | undefined,
    context: RequestContext,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.courseRepAssignment.updateMany({ where: { id: rep.id, status: from }, data });
      if (claimed.count !== 1) {
        throw conflict(
          'WRONG_STATUS',
          `This assignment is ${rep.status.toLowerCase()}, not ${from.toLowerCase()}.`,
        );
      }
      await this.audit.record(
        auditEntry(
          actor,
          action,
          { type: 'course_rep', id: rep.id },
          { before: { status: from }, after: { status: data.status }, reason },
          context,
        ),
        tx,
      );
    });
  }

  private async views(rows: CourseRepAssignment[]) {
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
        student: { id: student.id, studentNumber: student.studentNumber, fullName: student.fullName },
        section: { id: section.id, code: section.code },
        course: section.course,
        semester: section.semester,
        nominatedById: r.nominatedById,
        nominationNote: r.nominationNote,
        assignedById: r.assignedById,
        startsAt: r.startsAt,
        endedAt: r.endedAt,
        endReason: r.endReason,
        createdAt: r.createdAt,
      };
    });
  }
}
