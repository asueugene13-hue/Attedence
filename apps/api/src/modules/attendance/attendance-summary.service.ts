import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AttendanceStatus } from '@attendsure/shared';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StudentsService } from '../students/students.service.js';
import { type ClassFact, judgeClass, summarise, warning } from './calculation.js';

type Enrolment = { sectionId: string; enrolledAt: Date; endedAt: Date | null };
type ClassRow = Awaited<ReturnType<ClassSessionsService['forSections']>>[number];

/** Classes still to come that a student is expected at (for "how many more absences"). */
const UPCOMING = ['SCHEDULED', 'CONFIRMED', 'POSTPONED', 'UNCONFIRMED'];

/**
 * Attendance history and percentages (ATTENDANCE_FLOW §9; Phase 5 step 5): a student's own courses,
 * one course class by class, and a section's students for its lecturers and administrators. Worked
 * out from the records each time (nothing stored), with the interim D-09 settings.
 */
@Injectable()
export class AttendanceSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly students: StudentsService,
    private readonly enrollments: EnrollmentsService,
    private readonly classSessions: ClassSessionsService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly permissions: PermissionService,
    private readonly access: AcademicAccessService,
  ) {}

  /** The signed-in student's courses, each with its summary (and warning, once a minimum is set). */
  async mine(actor: AccessClaims) {
    const studentId = await this.studentOf(actor);
    const enrolments = await this.enrollments.enrolmentsOf(studentId);
    const byOffering = new Map<string, typeof enrolments>();
    for (const e of enrolments) byOffering.set(e.offeringId, [...(byOffering.get(e.offeringId) ?? []), e]);
    const policy = await this.policy();
    const data = [];
    for (const rows of byOffering.values()) {
      const course = await this.courseOf(rows[0]!.sectionId);
      const { summary, remaining } = await this.forStudent(studentId, rows);
      data.push({
        offeringId: rows[0]!.offeringId,
        course: course.course,
        semester: course.semester,
        enrolled: rows.some((r) => r.status === 'ENROLLED'),
        ...summary,
        warning: warning(summary, policy.lateWeight, policy.minimumPercent, remaining),
      });
    }
    return { lateWeight: policy.lateWeight, minimumPercent: policy.minimumPercent, data };
  }

  /**
   * Attendance open right now for the student's current classes (ATTENDANCE_FLOW §3): the phone
   * shows the scanner only when there is something to check in to.
   */
  async openForMe(actor: AccessClaims) {
    const studentId = await this.studentOf(actor);
    const now = this.clock.now();
    const sectionIds = await this.enrollments.activeSectionIds(studentId);
    const open = await this.prisma.attendanceSession.findMany({
      where: { status: 'OPEN', closesAt: { gt: now } },
      select: { id: true, classSessionId: true, closesAt: true, lateAfter: true },
    });
    const classes = await this.classSessions.facts(open.map((s) => s.classSessionId));
    const mine = open.filter((s) =>
      classes.get(s.classSessionId)?.sectionIds.some((id) => sectionIds.includes(id)),
    );
    const sections = await this.courses.sectionSummaries(
      mine.flatMap((s) => classes.get(s.classSessionId)!.sectionIds.filter((id) => sectionIds.includes(id))),
    );
    const records = await this.prisma.attendanceRecord.findMany({
      where: { studentId, classSessionId: { in: mine.map((s) => s.classSessionId) } },
      select: { classSessionId: true, status: true },
    });
    return {
      data: mine.map((s) => {
        const section = classes
          .get(s.classSessionId)!
          .sectionIds.map((id) => sections.get(id))
          .find(Boolean);
        return {
          attendanceSessionId: s.id,
          classSessionId: s.classSessionId,
          course: section?.course ?? null,
          closesAt: s.closesAt,
          lateAfter: s.lateAfter,
          myStatus: records.find((r) => r.classSessionId === s.classSessionId)?.status ?? null,
        };
      }),
    };
  }

  /** One of the student's courses, class by class: what counted, what did not, and why. */
  async mineForOffering(actor: AccessClaims, offeringId: string) {
    const studentId = await this.studentOf(actor);
    const rows = (await this.enrollments.enrolmentsOf(studentId)).filter((e) => e.offeringId === offeringId);
    if (rows.length === 0)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'You are not enrolled in this course.' });
    const policy = await this.policy();
    const course = await this.courseOf(rows[0]!.sectionId);
    const { summary, remaining, results } = await this.forStudent(studentId, rows);
    return {
      offeringId,
      course: course.course,
      semester: course.semester,
      ...summary,
      warning: warning(summary, policy.lateWeight, policy.minimumPercent, remaining),
      classes: results,
    };
  }

  /** Every student of a section, with their summary: for its lecturers and administrators in scope. */
  async section(actor: AccessClaims, sectionId: string) {
    const section = await this.courses.sectionFacts(sectionId);
    if (!section) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such section.' });
    const held = await this.permissions.forRole(actor.role);
    if (!held.has('attendance.roster_read')) throw this.denied();
    if (actor.role === 'LECTURER') {
      if (!(await this.lecturers.teaches(actor.userId, sectionId))) throw this.denied();
    } else {
      await this.access.assertDepartment(actor, section.department);
    }
    const policy = await this.policy();
    const enrolments = await this.enrollments.enrolmentsInSection(sectionId);
    const byStudent = new Map<string, Enrolment[]>();
    for (const e of enrolments)
      byStudent.set(e.studentId, [...(byStudent.get(e.studentId) ?? []), { ...e, sectionId }]);
    const classes = await this.classSessions.forSections([sectionId]);
    const people = await this.students.summaries([...byStudent.keys()]);
    const data = [];
    for (const [studentId, rows] of byStudent) {
      const { summary, remaining } = await this.forStudent(studentId, rows, classes);
      data.push({
        studentId,
        studentNumber: people.get(studentId)?.studentNumber ?? '',
        fullName: people.get(studentId)?.fullName ?? '',
        enrolled: enrolments.some((e) => e.studentId === studentId && e.status === 'ENROLLED'),
        ...summary,
        warning: warning(summary, policy.lateWeight, policy.minimumPercent, remaining),
      });
    }
    return {
      section: { id: section.id, code: section.code, course: section.course, semester: section.semester },
      lateWeight: policy.lateWeight,
      minimumPercent: policy.minimumPercent,
      classesHeld: classes.filter((c) => c.status === 'COMPLETED').length,
      data: data.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  }

  // ───────── Working it out ─────────

  private async forStudent(studentId: string, enrolments: Enrolment[], given?: ClassRow[]) {
    const sectionIds = [...new Set(enrolments.map((e) => e.sectionId))];
    const classes = (given ?? (await this.classSessions.forSections(sectionIds))).filter((c) =>
      c.sectionIds.some((s) => sectionIds.includes(s)),
    );
    const ids = classes.map((c) => c.id);
    const [sessions, records] = await Promise.all([
      this.prisma.attendanceSession.findMany({
        where: { classSessionId: { in: ids } },
        select: { classSessionId: true, status: true, closeReason: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { studentId, classSessionId: { in: ids } },
        select: { classSessionId: true, status: true },
      }),
    ]);
    const sessionOf = new Map(sessions.map((s) => [s.classSessionId, s]));
    const recordOf = new Map(records.map((r) => [r.classSessionId, r.status as AttendanceStatus]));
    const facts: ClassFact[] = classes.map((c) => {
      const s = sessionOf.get(c.id);
      return {
        classSessionId: c.id,
        scheduledStart: c.scheduledStart,
        classStatus: c.status,
        attendance: s ? { closed: s.status === 'CLOSED', voided: s.closeReason === 'CLASS_VOIDED' } : null,
        eligible: enrolments.some(
          (e) =>
            c.sectionIds.includes(e.sectionId) &&
            e.enrolledAt <= c.scheduledStart &&
            (!e.endedAt || e.endedAt > c.scheduledStart),
        ),
        record: recordOf.get(c.id) ?? null,
      };
    });
    const results = facts.map(judgeClass);
    const policy = await this.policy();
    const now = this.clock.now();
    const stillEnrolled = enrolments.filter((e) => !e.endedAt);
    const remaining = classes.filter(
      (c) =>
        c.scheduledStart > now &&
        UPCOMING.includes(c.status) &&
        stillEnrolled.some((e) => c.sectionIds.includes(e.sectionId)),
    ).length;
    return { summary: summarise(results, policy.lateWeight), remaining, results };
  }

  private async policy() {
    const [lateWeight, minimumPercent] = await Promise.all([
      this.settings.get('attendance.lateWeight'),
      this.settings.get('attendance.minimumPercent'),
    ]);
    return { lateWeight, minimumPercent };
  }

  private async studentOf(actor: AccessClaims) {
    const studentId = await this.students.idForUser(actor.userId);
    if (!studentId)
      throw new ForbiddenException({
        code: 'NOT_A_STUDENT',
        message: 'Only students have an attendance history.',
      });
    return studentId;
  }

  private async courseOf(sectionId: string) {
    const section = await this.courses.sectionFacts(sectionId);
    if (!section) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such section.' });
    return section;
  }

  private denied() {
    return new ForbiddenException({
      code: 'PERMISSION_DENIED',
      message: 'Only the section’s lecturers and administrators in scope can see its attendance.',
    });
  }
}
