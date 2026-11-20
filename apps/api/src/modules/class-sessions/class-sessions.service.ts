import { Injectable, NotFoundException } from '@nestjs/common';
import type { ClassSessionQuerySchema } from '@attendsure/shared';
import type { z } from 'zod';
import { wallClockToUtc } from '../../common/time-zone.js';
import { AppConfig } from '../../config/app-config.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { PlacesService } from '../places/places.service.js';
import { StudentsService } from '../students/students.service.js';

const sessionInclude = { sections: { select: { sectionId: true } } } satisfies Prisma.ClassSessionInclude;
type SessionRow = Prisma.ClassSessionGetPayload<{ include: typeof sessionInclude }>;

/** A filter that matches no class (a caller with no lecturer or student record). */
const NOTHING: Prisma.ClassSessionWhereInput = { id: { in: [] } };

const nextDay = (day: string) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

/** Reading class sessions: by filter, one with its history, and a person's own timetable. */
@Injectable()
export class ClassSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly places: PlacesService,
    private readonly enrollments: EnrollmentsService,
    private readonly students: StudentsService,
    private readonly access: AcademicAccessService,
  ) {}

  /**
   * Which classes a caller may see (ROLE_PERMISSION_MATRIX.md, "View timetable"): a lecturer only the
   * classes they teach and a student only their sections' classes ("own"); the Super Admin,
   * administrators and the Registrar the classes of the faculties and departments their role covers
   * (every class when it covers the whole university). null means no limit.
   */
  private async visibleTo(actor: AccessClaims): Promise<Prisma.ClassSessionWhereInput | null> {
    if (actor.role === 'LECTURER') {
      const lecturerId = await this.lecturers.idForUser(actor.userId);
      return lecturerId ? { lecturerId } : NOTHING;
    }
    if (actor.role === 'STUDENT') {
      const studentId = await this.students.idForUser(actor.userId);
      if (!studentId) return NOTHING;
      return {
        sections: { some: { sectionId: { in: await this.enrollments.activeSectionIds(studentId) } } },
      };
    }
    const scope = await this.access.scopeOf(actor);
    if (scope.institutionWide) return null;
    // A read-only join to filter by department, as class analytics does (rule 8 allows reading).
    return {
      sections: {
        some: {
          section: {
            offering: {
              course: {
                OR: [
                  { departmentId: { in: scope.departmentIds } },
                  { department: { facultyId: { in: scope.facultyIds } } },
                ],
              },
            },
          },
        },
      },
    };
  }

  /** The class list as this caller may see it (route `GET /class-sessions`, the class monitor). */
  async listFor(actor: AccessClaims, query: z.output<typeof ClassSessionQuerySchema>) {
    const visible = await this.visibleTo(actor);
    return this.list(query, visible ?? {});
  }

  /** One class with its history, if this caller may see it; otherwise "no such class session". */
  async getFor(actor: AccessClaims, id: string) {
    const visible = await this.visibleTo(actor);
    if (visible && !(await this.prisma.classSession.count({ where: { AND: [{ id }, visible] } }))) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such class session.' });
    }
    return this.get(id);
  }

  /** Sessions between two local dates (inclusive), in the university's time zone. */
  async list(query: z.output<typeof ClassSessionQuerySchema>, visible: Prisma.ClassSessionWhereInput = {}) {
    const rows = await this.prisma.classSession.findMany({
      where: {
        AND: [
          {
            ...this.range(query.from, query.to),
            ...(query.lecturerId ? { lecturerId: query.lecturerId } : {}),
            ...(query.classroomId ? { classroomId: query.classroomId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.sectionId ? { sections: { some: { sectionId: query.sectionId } } } : {}),
          },
          visible,
        ],
      },
      orderBy: { scheduledStart: 'asc' },
      include: sessionInclude,
      take: 2000,
    });
    return { data: await this.views(rows) };
  }

  async get(id: string) {
    const row = await this.prisma.classSession.findUnique({
      where: { id },
      include: { ...sessionInclude, events: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such class session.' });
    const [view] = await this.views([row]);
    return {
      ...view!,
      events: row.events.map((e) => ({
        id: e.id,
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorType: e.actorType,
        actorUserId: e.actorUserId,
        payload: e.payload,
        occurredAt: e.occurredAt,
      })),
    };
  }

  /**
   * The caller's own classes: a lecturer sees the sessions they teach; a student (or course rep) the
   * sessions of the sections they are enrolled in. Cancelled classes are included, marked as such.
   */
  async mine(actor: AccessClaims, from: string, to: string) {
    if (actor.role === 'LECTURER') {
      const lecturerId = await this.lecturers.idForUser(actor.userId);
      if (!lecturerId) return { as: 'LECTURER', data: [] };
      return { as: 'LECTURER', ...(await this.list({ from, to, lecturerId })) };
    }
    const studentId = await this.students.idForUser(actor.userId);
    if (!studentId) return { as: 'NONE', data: [] };
    const sectionIds = await this.enrollments.activeSectionIds(studentId);
    const rows = await this.prisma.classSession.findMany({
      where: { ...this.range(from, to), sections: { some: { sectionId: { in: sectionIds } } } },
      orderBy: { scheduledStart: 'asc' },
      include: sessionInclude,
    });
    return { as: 'STUDENT', data: await this.views(rows) };
  }

  /** Session views by id, for other parts of this module (reschedule requests). */
  /** Every class meeting of these sections, oldest first, as facts (for attendance percentages). */
  async forSections(sectionIds: string[]) {
    const rows = await this.prisma.classSession.findMany({
      where: { sections: { some: { sectionId: { in: [...new Set(sectionIds)] } } } },
      include: sessionInclude,
      orderBy: { scheduledStart: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      scheduledStart: r.scheduledStart,
      scheduledEnd: r.scheduledEnd,
      sectionIds: r.sections.map((s) => s.sectionId),
    }));
  }

  /** The facts other modules need about classes (attendance): status, lecturer, times, sections. */
  async facts(ids: string[], tx: Prisma.TransactionClient = this.prisma) {
    const rows = await tx.classSession.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: sessionInclude,
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          status: r.status,
          lecturerId: r.lecturerId,
          classroomId: r.classroomId,
          scheduledStart: r.scheduledStart,
          scheduledEnd: r.scheduledEnd,
          actualStart: r.actualStart,
          sectionIds: r.sections.map((s) => s.sectionId),
        },
      ]),
    );
  }

  /**
   * The class running in a room at a moment, if any: started by then and still ACTIVE (classes left
   * running are ended by the class monitor). Used by beacon health.
   */
  async runningInRoom(classroomId: string, at: Date): Promise<{ id: string } | null> {
    return this.prisma.classSession.findFirst({
      where: { classroomId, status: 'ACTIVE', actualStart: { lte: at } },
      orderBy: { actualStart: 'desc' },
      select: { id: true },
    });
  }

  /**
   * The rooms where this lecturer's own class is running at a moment (started and still ACTIVE). Used to
   * limit what a lecturer sees of beacons to "during own class" (ROLE_PERMISSION_MATRIX.md).
   */
  async roomsTeachingNow(lecturerId: string, at: Date): Promise<Set<string>> {
    const rows = await this.prisma.classSession.findMany({
      where: { lecturerId, status: 'ACTIVE', actualStart: { lte: at } },
      select: { classroomId: true },
    });
    return new Set(rows.map((r) => r.classroomId));
  }

  async summaries(ids: string[]) {
    const rows = await this.prisma.classSession.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: sessionInclude,
    });
    return new Map((await this.views(rows)).map((v) => [v.id, v]));
  }

  private range(from: string, to: string) {
    const tz = this.config.institutionTimezone;
    return { scheduledStart: { gte: wallClockToUtc(from, 0, tz), lt: wallClockToUtc(nextDay(to), 0, tz) } };
  }

  private async views(rows: SessionRow[]) {
    const [sections, lecturers, rooms] = await Promise.all([
      this.courses.sectionSummaries(rows.flatMap((r) => r.sections.map((s) => s.sectionId))),
      this.lecturers.facts(rows.map((r) => r.lecturerId)),
      this.places.classroomFacts(rows.map((r) => r.classroomId)),
    ]);
    return rows.map((r) => {
      const lecturer = lecturers.get(r.lecturerId);
      const room = rooms.get(r.classroomId);
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        scheduledStart: r.scheduledStart,
        scheduledEnd: r.scheduledEnd,
        expectedStart: r.expectedStart,
        sections: r.sections.map((s) => {
          const info = sections.get(s.sectionId)!;
          return { id: info.id, code: info.code, course: info.course };
        }),
        lecturer: lecturer ? { id: lecturer.id, fullName: lecturer.fullName, userId: lecturer.userId } : null,
        classroom: room ? { id: room.id, code: room.code, name: room.name } : null,
        cancelReason: r.cancelReason,
        cancelNote: r.cancelNote,
        timetableEntryId: r.timetableEntryId,
        rescheduledFromId: r.rescheduledFromId,
        version: r.version,
      };
    });
  }
}
