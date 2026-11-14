import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AnnouncementFeedQuerySchema, SendAnnouncementSchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { dbErrorInfo, PG } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { dayIn, wallClockToUtc } from '../../common/time-zone.js';
import { AppConfig } from '../../config/app-config.js';
import type { Announcement } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { ScopeService } from '../authorization/scope.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { CourseRepsService } from '../enrollments/course-reps.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StudentsService } from '../students/students.service.js';

type SendInput = z.output<typeof SendAnnouncementSchema>;
const ADMIN_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN'];
const forbidden = (code: string, message: string) => new ForbiddenException({ code, message });
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such announcement.' });

/**
 * Announcements (Phase 6 step 4). Who may send to whom:
 * - a lecturer: official announcements to the sections they teach;
 * - an administrator: official announcements to sections, a department or a faculty in their scope,
 *   or (with `announcements.send_institution` and university-wide scope) to everyone;
 * - a course rep (a student with an active rep assignment): updates to their own section, labelled
 *   "Course rep", at most `announcements.repDailyLimit` per section per day (Africa/Accra).
 * Recipients (active students in the audience) are fixed when it is sent. Recipients can report one;
 * administrators in scope, and lecturers for their own sections, can hide it with a reason.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionService,
    private readonly scopes: ScopeService,
    private readonly access: AcademicAccessService,
    private readonly academic: AcademicLookupsService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly students: StudentsService,
    private readonly enrollments: EnrollmentsService,
    private readonly reps: CourseRepsService,
  ) {}

  // ───────── Sending ─────────

  /** What the caller may send to: their sections (with a rep's allowance today), departments, faculties. */
  async targets(actor: AccessClaims) {
    const held = await this.permissions.forRole(actor.role);
    if (actor.role === 'STUDENT') {
      const studentId = await this.students.idForUser(actor.userId);
      const sectionIds = studentId ? await this.enrollments.activeSectionIds(studentId) : [];
      const repOf = studentId ? await this.reps.activeRepSectionIds(studentId, sectionIds) : [];
      const limit = await this.settings.get('announcements.repDailyLimit');
      const sections = await this.sectionChoices(repOf);
      return {
        kind: 'COURSE_REP' as const,
        dailyLimit: limit,
        sections: await Promise.all(
          sections.map(async (s) => ({ ...s, remainingToday: limit - (await this.repPostsToday(s.id)) })),
        ),
        departments: [],
        faculties: [],
        institution: false,
      };
    }
    if (actor.role === 'LECTURER' && held.has('announcements.send_official')) {
      const teaching = await this.lecturers.myTeaching(actor.userId);
      return {
        kind: 'OFFICIAL' as const,
        sections: await this.sectionChoices(teaching.sections.map((s) => s.sectionId)),
        departments: [],
        faculties: [],
        institution: false,
      };
    }
    if (ADMIN_ROLES.includes(actor.role) && held.has('announcements.send_official')) {
      const structure = await this.academic.activeStructure();
      const departments = [];
      for (const d of structure.departments) if (await this.access.covers(actor, d)) departments.push(d);
      const faculties = [];
      for (const f of structure.faculties)
        if (await this.access.coversFaculty(actor, f.id)) faculties.push(f);
      return {
        kind: 'OFFICIAL' as const,
        sections: [],
        departments,
        faculties,
        institution:
          held.has('announcements.send_institution') && (await this.access.coversInstitution(actor)),
      };
    }
    throw forbidden('PERMISSION_DENIED', 'You cannot send announcements.');
  }

  async send(actor: AccessClaims, input: SendInput, context: RequestContext) {
    const kind = await this.assertMaySend(actor, input);
    const recipients = await this.recipientsOf(input);
    if (recipients.length === 0) {
      throw new ConflictException({
        code: 'NO_RECIPIENTS',
        message: 'Nobody would receive this announcement.',
      });
    }
    const now = this.clock.now();
    const announcement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.announcement.create({
        data: {
          authorId: actor.userId,
          authorRole: actor.role,
          kind,
          scope: input.scope,
          departmentId: input.departmentId ?? null,
          facultyId: input.facultyId ?? null,
          title: input.title,
          body: input.body,
          emailed: input.email,
          sentAt: now,
          sections: input.sectionIds
            ? { create: input.sectionIds.map((sectionId) => ({ sectionId })) }
            : undefined,
        },
      });
      await tx.announcementRecipient.createMany({
        data: recipients.map((userId) => ({ announcementId: created.id, userId })),
      });
      await this.audit.record(
        auditEntry(
          actor,
          'announcements.sent',
          { type: 'announcement', id: created.id },
          {
            after: {
              kind,
              scope: input.scope,
              sectionIds: input.sectionIds,
              departmentId: input.departmentId,
              facultyId: input.facultyId,
              recipients: recipients.length,
              emailed: input.email,
            },
          },
          context,
        ),
        tx,
      );
      return created;
    });
    await this.notifications.notify({
      userIds: recipients,
      category: input.email ? 'ANNOUNCEMENT_EMAILED' : 'ANNOUNCEMENT',
      title: kind === 'COURSE_REP' ? `Course rep update: ${input.title}` : input.title,
      body: input.body,
      data: { path: `/announcements/${announcement.id}` },
      related: { type: 'announcement', id: announcement.id },
      dedupeKey: `announcement:${announcement.id}`,
    });
    return this.authorView(announcement);
  }

  // ───────── Reading (recipients) ─────────

  /** The caller's announcements, newest first; hidden ones are left out. */
  async feed(actor: AccessClaims, query: z.output<typeof AnnouncementFeedQuerySchema>) {
    const rows = await this.prisma.announcementRecipient.findMany({
      where: {
        userId: actor.userId,
        announcement: { status: 'PUBLISHED', ...(query.kind ? { kind: query.kind } : {}) },
      },
      include: { announcement: { include: { author: { select: { fullName: true } }, sections: true } } },
      orderBy: { announcementId: 'desc' },
      take: query.limit + 1,
      ...(query.cursor
        ? {
            cursor: { announcementId_userId: { announcementId: query.cursor, userId: actor.userId } },
            skip: 1,
          }
        : {}),
    });
    const page = rows.slice(0, query.limit);
    const audience = await this.audienceLabels(page.map((r) => r.announcement));
    return {
      data: page.map((r) => ({
        id: r.announcement.id,
        kind: r.announcement.kind,
        title: r.announcement.title,
        body: r.announcement.body,
        sentAt: r.announcement.sentAt,
        author: r.announcement.author.fullName,
        audience: audience.get(r.announcement.id) ?? '',
        read: r.readAt !== null,
      })),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.announcementId ?? null) : null,
    };
  }

  async unreadCount(actor: AccessClaims) {
    const unread = await this.prisma.announcementRecipient.count({
      where: { userId: actor.userId, readAt: null, announcement: { status: 'PUBLISHED' } },
    });
    return { unread };
  }

  async markRead(actor: AccessClaims, id: string) {
    const updated = await this.prisma.announcementRecipient.updateMany({
      where: { announcementId: id, userId: actor.userId, readAt: null },
      data: { readAt: this.clock.now() },
    });
    if (updated.count === 0) {
      const exists = await this.prisma.announcementRecipient.count({
        where: { announcementId: id, userId: actor.userId },
      });
      if (!exists) throw notFound();
    }
    return { read: true };
  }

  /** A recipient reports it as offensive or misleading (once); moderators are told. */
  async report(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    const received = await this.prisma.announcementRecipient.findUnique({
      where: { announcementId_userId: { announcementId: id, userId: actor.userId } },
      include: { announcement: { include: { sections: true } } },
    });
    if (!received) throw notFound();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.announcementReport.create({
          data: { announcementId: id, reporterId: actor.userId, reason, createdAt: this.clock.now() },
        });
        await this.audit.record(
          auditEntry(actor, 'announcements.reported', { type: 'announcement', id }, { reason }, context),
          tx,
        );
      });
    } catch (error) {
      if (dbErrorInfo(error)?.pgCode === PG.uniqueViolation) {
        throw new ConflictException({ code: 'ALREADY_REPORTED', message: 'You have already reported this.' });
      }
      throw error;
    }
    await this.notifications.notify({
      userIds: await this.moderatorsOf(received.announcement),
      category: 'ANNOUNCEMENT_REPORTED',
      title: 'An announcement was reported',
      body: `A student reported “${received.announcement.title}”: ${reason}`,
      data: { path: '/announcements?view=REPORTED' },
      related: { type: 'announcement', id },
      dedupeKey: `announcement-reported:${id}:${actor.userId}`,
    });
    return { reported: true };
  }

  // ───────── Authors and moderators ─────────

  /** MINE: what the caller sent, with counts. REPORTED: reported ones the caller may moderate. */
  async list(actor: AccessClaims, view: 'MINE' | 'REPORTED') {
    if (view === 'MINE') {
      const rows = await this.prisma.announcement.findMany({
        where: { authorId: actor.userId },
        orderBy: { sentAt: 'desc' },
        take: 100,
      });
      return { data: await Promise.all(rows.map((r) => this.authorView(r))) };
    }
    const rows = await this.prisma.announcement.findMany({
      where: { reports: { some: {} } },
      include: { sections: true },
      orderBy: { sentAt: 'desc' },
      take: 200,
    });
    const visible = [];
    for (const r of rows) if (await this.mayModerate(actor, r)) visible.push(r);
    return {
      data: await Promise.all(
        visible.map(async (r) => ({
          ...(await this.authorView(r)),
          reports: (
            await this.prisma.announcementReport.findMany({
              where: { announcementId: r.id },
              orderBy: { createdAt: 'asc' },
            })
          ).map((x) => ({ reason: x.reason, at: x.createdAt })),
        })),
      ),
    };
  }

  /** Delivery and read counts, for the author and moderators. */
  async stats(actor: AccessClaims, id: string) {
    const announcement = await this.find(id);
    if (announcement.authorId !== actor.userId && !(await this.mayModerate(actor, announcement)))
      throw notFound();
    return this.authorView(announcement);
  }

  async hide(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    const announcement = await this.find(id);
    if (!(await this.mayModerate(actor, announcement))) {
      throw forbidden('PERMISSION_DENIED', 'You cannot hide this announcement.');
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.announcement.updateMany({
        where: { id, status: 'PUBLISHED' },
        data: { status: 'HIDDEN', hiddenById: actor.userId, hiddenAt: now, hiddenReason: reason },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: 'ALREADY_HIDDEN',
          message: 'This announcement is already hidden.',
        });
      }
      await this.audit.record(
        auditEntry(actor, 'announcements.hidden', { type: 'announcement', id }, { reason }, context),
        tx,
      );
    });
    return this.authorView(await this.find(id));
  }

  // ───────── Helpers ─────────

  private async find(id: string): Promise<Announcement & { sections: { sectionId: string }[] }> {
    const row = await this.prisma.announcement.findUnique({ where: { id }, include: { sections: true } });
    if (!row) throw notFound();
    return row;
  }

  /** Checks the caller may send this; returns the kind it will be sent as. */
  private async assertMaySend(actor: AccessClaims, input: SendInput): Promise<'OFFICIAL' | 'COURSE_REP'> {
    const held = await this.permissions.forRole(actor.role);
    const sectionIds = input.sectionIds ?? [];
    if (actor.role === 'STUDENT') {
      if (input.scope !== 'SECTION')
        throw forbidden('PERMISSION_DENIED', 'Course reps post to their own section.');
      const studentId = await this.students.idForUser(actor.userId);
      const repOf = studentId ? await this.reps.activeRepSectionIds(studentId, sectionIds) : [];
      if (repOf.length !== new Set(sectionIds).size) {
        throw forbidden('NOT_COURSE_REP', 'Only the course rep of a section can post updates to it.');
      }
      const limit = await this.settings.get('announcements.repDailyLimit');
      for (const sectionId of sectionIds) {
        if ((await this.repPostsToday(sectionId)) >= limit) {
          throw new ConflictException({
            code: 'REP_LIMIT_REACHED',
            message: `A section can receive at most ${limit} course-rep updates a day. Try again tomorrow.`,
          });
        }
      }
      return 'COURSE_REP';
    }
    if (!held.has('announcements.send_official')) {
      throw forbidden('PERMISSION_DENIED', 'You cannot send announcements.');
    }
    if (actor.role === 'LECTURER') {
      if (input.scope !== 'SECTION') {
        throw forbidden('PERMISSION_DENIED', 'Lecturers send announcements to the sections they teach.');
      }
      for (const sectionId of sectionIds) {
        if (!(await this.lecturers.teaches(actor.userId, sectionId))) {
          throw forbidden('NOT_YOUR_SECTION', 'You can only send announcements to the sections you teach.');
        }
      }
      return 'OFFICIAL';
    }
    if (!ADMIN_ROLES.includes(actor.role))
      throw forbidden('PERMISSION_DENIED', 'You cannot send announcements.');
    if (input.scope === 'SECTION') {
      const sections = await this.courses.sectionSummaries(sectionIds);
      if (sections.size !== new Set(sectionIds).size) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such section.' });
      }
      for (const s of sections.values()) await this.access.assertDepartment(actor, s.department);
    } else if (input.scope === 'DEPARTMENT') {
      const department = await this.academic.department(input.departmentId!);
      if (!department?.isActive)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such department.' });
      await this.access.assertDepartment(actor, department);
    } else if (input.scope === 'FACULTY') {
      const faculty = await this.academic.faculty(input.facultyId!);
      if (!faculty?.isActive) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such faculty.' });
      await this.access.assertFaculty(actor, faculty.id);
    } else {
      if (!held.has('announcements.send_institution')) {
        throw forbidden('PERMISSION_DENIED', 'You cannot send university-wide announcements.');
      }
      await this.access.assertInstitutionWide(actor);
    }
    return 'OFFICIAL';
  }

  /** Active students in the audience, worked out now. */
  private async recipientsOf(input: SendInput): Promise<string[]> {
    if (input.scope === 'SECTION') {
      const bySection = await this.enrollments.enrolledBySection(input.sectionIds!);
      return this.students.activeUserIds([...bySection.values()].flat());
    }
    if (input.scope === 'DEPARTMENT')
      return this.students.activeUserIdsIn({ departmentId: input.departmentId });
    if (input.scope === 'FACULTY') return this.students.activeUserIdsIn({ facultyId: input.facultyId });
    return this.students.activeUserIdsIn({});
  }

  /** Course-rep updates a section has received today (Africa/Accra). */
  private async repPostsToday(sectionId: string): Promise<number> {
    const tz = this.config.institutionTimezone;
    const start = wallClockToUtc(dayIn(this.clock.now(), tz), 0, tz);
    return this.prisma.announcement.count({
      where: { kind: 'COURSE_REP', sentAt: { gte: start }, sections: { some: { sectionId } } },
    });
  }

  /**
   * Administrators whose scope covers the audience, and (for section announcements) the lecturers
   * teaching those sections, when they hold `announcements.moderate`.
   */
  private async mayModerate(
    actor: AccessClaims,
    a: Announcement & { sections: { sectionId: string }[] },
  ): Promise<boolean> {
    const held = await this.permissions.forRole(actor.role);
    if (!held.has('announcements.moderate')) return false;
    const sectionIds = a.sections.map((s) => s.sectionId);
    if (actor.role === 'LECTURER') {
      if (a.scope !== 'SECTION') return false;
      for (const sectionId of sectionIds)
        if (await this.lecturers.teaches(actor.userId, sectionId)) return true;
      return false;
    }
    if (!ADMIN_ROLES.includes(actor.role)) return false;
    if (a.scope === 'SECTION') {
      const sections = await this.courses.sectionSummaries(sectionIds);
      for (const s of sections.values()) if (!(await this.access.covers(actor, s.department))) return false;
      return true;
    }
    if (a.scope === 'DEPARTMENT') {
      const department = await this.academic.department(a.departmentId!);
      return department ? this.access.covers(actor, department) : false;
    }
    if (a.scope === 'FACULTY') return this.access.coversFaculty(actor, a.facultyId!);
    return this.access.coversInstitution(actor);
  }

  private async moderatorsOf(a: Announcement & { sections: { sectionId: string }[] }): Promise<string[]> {
    const ids = new Set<string>();
    if (a.scope === 'SECTION') {
      const sectionIds = a.sections.map((s) => s.sectionId);
      for (const id of await this.lecturers.teacherUserIds(sectionIds)) if (id !== a.authorId) ids.add(id);
      for (const s of (await this.courses.sectionSummaries(sectionIds)).values()) {
        for (const id of await this.scopes.holdersCovering('UNIVERSITY_ADMIN', s.department)) ids.add(id);
      }
    } else if (a.scope === 'DEPARTMENT') {
      const d = await this.academic.department(a.departmentId!);
      if (d) for (const id of await this.scopes.holdersCovering('UNIVERSITY_ADMIN', d)) ids.add(id);
    }
    if (ids.size === 0) {
      // Faculty and university-wide announcements (or nobody found above): administrators covering the
      // faculty or the whole university. No real department has an empty id, so only those match.
      const everyone = await this.scopes.holdersCovering('UNIVERSITY_ADMIN', {
        id: '',
        facultyId: a.facultyId ?? '',
      });
      for (const id of everyone) ids.add(id);
    }
    return [...ids];
  }

  private async sectionChoices(sectionIds: string[]) {
    const sections = await this.courses.sectionSummaries(sectionIds);
    const enrolled = await this.enrollments.enrolledBySection(sectionIds);
    return [...sections.values()].map((s) => ({
      id: s.id,
      code: s.code,
      course: s.course,
      students: enrolled.get(s.id)?.length ?? 0,
    }));
  }

  /** "CSC 204 · A", "Department of …", "All students": who an announcement was for. */
  private async audienceLabels(rows: (Announcement & { sections: { sectionId: string }[] })[]) {
    const sections = await this.courses.sectionSummaries(
      rows.flatMap((r) => r.sections.map((s) => s.sectionId)),
    );
    const labels = new Map<string, string>();
    for (const r of rows) {
      if (r.scope === 'SECTION') {
        labels.set(
          r.id,
          r.sections
            .map((s) => sections.get(s.sectionId))
            .filter((s) => s !== undefined)
            .map((s) => `${s.course.code} · ${s.code}`)
            .join(', '),
        );
      } else if (r.scope === 'INSTITUTION') {
        labels.set(r.id, 'All students');
      } else if (r.scope === 'DEPARTMENT') {
        labels.set(r.id, 'Your department');
      } else {
        labels.set(r.id, 'Your faculty');
      }
    }
    return labels;
  }

  private async authorView(a: Announcement) {
    const [recipients, read, reports, sections] = await Promise.all([
      this.prisma.announcementRecipient.count({ where: { announcementId: a.id } }),
      this.prisma.announcementRecipient.count({ where: { announcementId: a.id, readAt: { not: null } } }),
      this.prisma.announcementReport.count({ where: { announcementId: a.id } }),
      this.prisma.announcementSection.findMany({ where: { announcementId: a.id } }),
    ]);
    const audience = (await this.audienceLabels([{ ...a, sections }])).get(a.id) ?? '';
    return {
      id: a.id,
      kind: a.kind,
      scope: a.scope,
      audience,
      title: a.title,
      body: a.body,
      sentAt: a.sentAt,
      status: a.status,
      hiddenReason: a.hiddenReason,
      emailed: a.emailed,
      counts: {
        recipients,
        read,
        reports,
        emailsSent: a.emailed ? await this.notifications.emailsSent({ type: 'announcement', id: a.id }) : 0,
      },
    };
  }
}
