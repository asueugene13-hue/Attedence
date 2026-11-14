import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type ApproveExcuseSchema,
  EXCUSABLE_STATUSES,
  type ExcuseStatus,
  OPEN_EXCUSE_STATUSES,
  type RejectExcuseSchema,
  REQUEST_ATTACHMENT_LIMITS,
  type SubmitExcuseSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import { wallClockToUtc } from '../../common/time-zone.js';
import type { UploadedBytes } from '../../common/upload.js';
import { AppConfig } from '../../config/app-config.js';
import type { ExcuseRequest, Prisma } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AttendanceRecordsService } from '../attendance/records.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { ScopeService } from '../authorization/scope.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { FilesService } from '../files/files.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StudentsService } from '../students/students.service.js';
import { requestAttachmentType } from './attachments.js';

const DAY = 24 * 3_600_000;
const OPEN: ExcuseStatus[] = [...OPEN_EXCUSE_STATUSES];
/** Classes that did not take place as planned are not covered (they never count as absences). */
const NOT_HELD = ['CANCELLED', 'RESCHEDULED'];
/** What lecturers see in a record's history: nothing about the reason (D-22). */
const CORRECTION_REASON = 'Excused: an excuse request was approved by an administrator.';
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such excuse request.' });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Excuse requests (ATTENDANCE_FLOW §7; Phase 6 step 3; decision D-22). A student asks to be excused
 * from their classes in some dates (at most 31), with a category, details and optional files, until a
 * set number of days after the last class covered. Only administrators whose scope covers the
 * student's department see and decide it; lecturers see only that a class was excused. Approval names
 * the classes to excuse; each of their records that is absent or rejected becomes EXCUSED through the
 * attendance module (a correction and an audit entry each). A class attended stays as it is. A class
 * whose record does not exist yet is excused when it appears (a job every 15 minutes).
 */
@Injectable()
export class ExcusesService implements OnModuleInit {
  private readonly logger = new Logger(ExcusesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly jobs: JobRegistry,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly students: StudentsService,
    private readonly enrollments: EnrollmentsService,
    private readonly records: AttendanceRecordsService,
    private readonly classSessions: ClassSessionsService,
    private readonly courses: CoursesService,
    private readonly access: AcademicAccessService,
    private readonly scopes: ScopeService,
  ) {}

  onModuleInit(): void {
    this.jobs.define({
      queue: 'monitoring',
      name: 'excuses-apply',
      attempts: 3,
      handle: async () => {
        await this.applyApproved();
      },
    });
    this.jobs.every('monitoring', 'excuses-apply', 15 * 60_000);
  }

  // ───────── The student ─────────

  async submit(actor: AccessClaims, input: z.output<typeof SubmitExcuseSchema>, context: RequestContext) {
    const studentId = await this.ownStudentId(actor);
    const covered = await this.classesIn(studentId, input.startDate, input.endDate);
    let chosen = covered;
    if (input.classSessionIds) {
      const ids = new Set(covered.map((c) => c.id));
      const outside = input.classSessionIds.filter((id) => !ids.has(id));
      if (outside.length > 0) {
        throw new BadRequestException({
          code: 'NOT_COVERED',
          message: 'Some of the chosen classes are not your classes in these dates.',
        });
      }
      const wanted = new Set(input.classSessionIds);
      chosen = covered.filter((c) => wanted.has(c.id));
    }
    if (chosen.length === 0) {
      throw conflict('NO_CLASSES', 'You have no classes in these dates, so there is nothing to excuse.');
    }
    const days = await this.settings.get('requests.excuseDays');
    const now = this.clock.now();
    const last = chosen.at(-1)!.scheduledStart;
    if (now.getTime() > last.getTime() + days * DAY) {
      throw conflict(
        'EXCUSE_WINDOW_PASSED',
        `Excuse requests are accepted for ${days} days after the last class they cover. Ask an administrator if something is wrong.`,
      );
    }
    const already = await this.prisma.excuseRequestClass.findMany({
      where: {
        classSessionId: { in: chosen.map((c) => c.id) },
        request: {
          studentId,
          OR: [{ status: { in: OPEN } }, { status: 'APPROVED' }],
        },
        // Open requests (not decided yet: null) and classes an approval excused; not ones it left out.
        OR: [{ included: null }, { included: true }],
      },
      select: { classSessionId: true },
    });
    if (already.length > 0) {
      throw conflict(
        'ALREADY_REQUESTED',
        `${already.length} of these classes are already in another excuse request of yours.`,
      );
    }
    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.excuseRequest.create({
        data: {
          studentId,
          category: input.category,
          description: input.description,
          startDate: new Date(`${input.startDate}T00:00:00Z`),
          endDate: new Date(`${input.endDate}T00:00:00Z`),
          submittedAt: now,
          classes: { create: chosen.map((c) => ({ classSessionId: c.id })) },
        },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'excuses.submitted',
          { type: 'excuse_request', id: created.id },
          {
            after: {
              category: input.category,
              startDate: input.startDate,
              endDate: input.endDate,
              classes: chosen.length,
            },
          },
          context,
        ),
        tx,
      );
      return created;
    });
    const department = await this.departmentOf(studentId);
    await this.notifications.notify({
      userIds: await this.scopes.holdersCovering('UNIVERSITY_ADMIN', department),
      category: 'EXCUSE_SUBMITTED',
      title: 'An excuse request to decide',
      body: `A student asks to be excused from ${chosen.length} class${chosen.length === 1 ? '' : 'es'} (${label(input.category)}).`,
      data: { path: `/reviews?excuse=${request.id}` },
      related: { type: 'excuse_request', id: request.id },
      dedupeKey: `excuse-submitted:${request.id}`,
    });
    return this.view(request);
  }

  async attach(actor: AccessClaims, id: string, upload: UploadedBytes, context: RequestContext) {
    const request = await this.ownRequest(actor, id);
    if (!OPEN.includes(request.status)) throw conflict('NOT_OPEN', 'This excuse request is closed.');
    const count = await this.prisma.excuseAttachment.count({ where: { excuseRequestId: id } });
    if (count >= REQUEST_ATTACHMENT_LIMITS.maxFiles) {
      throw conflict('TOO_MANY_FILES', `At most ${REQUEST_ATTACHMENT_LIMITS.maxFiles} files per request.`);
    }
    const type = requestAttachmentType(upload);
    const stored = await this.files.store({
      purpose: 'REQUEST_ATTACHMENT',
      bytes: upload.buffer,
      mimeType: type,
      originalName: upload.originalname,
      uploadedById: actor.userId,
    });
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.excuseAttachment.create({
          data: { excuseRequestId: id, fileId: stored.id, addedAt: this.clock.now() },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'excuses.attachment_added',
            { type: 'excuse_request', id },
            { after: { fileId: stored.id, mimeType: type, sizeBytes: upload.buffer.length } },
            context,
          ),
          tx,
        );
      });
    } catch (error) {
      await this.files.discard(stored);
      throw error;
    }
    return this.view(await this.find(id));
  }

  async reply(actor: AccessClaims, id: string, reply: string, context: RequestContext) {
    const request = await this.ownRequest(actor, id);
    if (request.status !== 'INFO_REQUESTED') {
      throw conflict('NO_QUESTION', 'Nobody is waiting for an answer on this request.');
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, request, ['INFO_REQUESTED'], { status: 'SUBMITTED' });
      await tx.excuseMessage.create({
        data: { excuseRequestId: id, kind: 'REPLY', body: reply, authorId: actor.userId, createdAt: now },
      });
      await this.audit.record(
        auditEntry(actor, 'excuses.replied', { type: 'excuse_request', id }, {}, context),
        tx,
      );
    });
    const asker = await this.prisma.excuseMessage.findFirst({
      where: { excuseRequestId: id, kind: 'QUESTION' },
      orderBy: { createdAt: 'desc' },
    });
    if (asker) {
      await this.notifications.notify({
        userIds: [asker.authorId],
        category: 'EXCUSE_REPLIED',
        title: 'A student answered your question',
        body: 'The student replied about their excuse request. Open it to read the answer.',
        data: { path: `/reviews?excuse=${id}` },
        related: { type: 'excuse_request', id },
        dedupeKey: `excuse-replied:${id}:${now.getTime()}`,
      });
    }
    return this.view(await this.find(id));
  }

  async withdraw(actor: AccessClaims, id: string, context: RequestContext) {
    const request = await this.ownRequest(actor, id);
    if (!OPEN.includes(request.status)) throw conflict('NOT_OPEN', 'This excuse request is already closed.');
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, request, OPEN, { status: 'WITHDRAWN' });
      await this.audit.record(
        auditEntry(actor, 'excuses.withdrawn', { type: 'excuse_request', id }, {}, context),
        tx,
      );
    });
    return this.view(await this.find(id));
  }

  // ───────── Administrators in scope decide ─────────

  async ask(actor: AccessClaims, id: string, question: string, context: RequestContext) {
    const request = await this.reviewable(actor, id);
    if (request.status !== 'SUBMITTED') {
      throw conflict(
        request.status === 'INFO_REQUESTED' ? 'WAITING_FOR_STUDENT' : 'NOT_OPEN',
        request.status === 'INFO_REQUESTED'
          ? 'The student has not answered the last question yet.'
          : 'This excuse request is closed.',
      );
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, request, ['SUBMITTED'], { status: 'INFO_REQUESTED' });
      await tx.excuseMessage.create({
        data: {
          excuseRequestId: id,
          kind: 'QUESTION',
          body: question,
          authorId: actor.userId,
          createdAt: now,
        },
      });
      await this.audit.record(
        auditEntry(actor, 'excuses.info_requested', { type: 'excuse_request', id }, {}, context),
        tx,
      );
    });
    await this.notifyStudent(request.studentId, {
      category: 'EXCUSE_INFO_REQUESTED',
      title: 'A question about your excuse request',
      body: `An administrator asks: ${question} Reply in the app; the request waits for your answer.`,
      id,
      key: `excuse-question:${id}:${now.getTime()}`,
    });
    return this.view(await this.find(id));
  }

  async approve(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof ApproveExcuseSchema>,
    context: RequestContext,
  ) {
    const request = await this.reviewable(actor, id);
    if (!OPEN.includes(request.status))
      throw conflict('ALREADY_DECIDED', 'This excuse request is already closed.');
    const covered = await this.prisma.excuseRequestClass.findMany({ where: { excuseRequestId: id } });
    const coveredIds = new Set(covered.map((c) => c.classSessionId));
    const chosen = new Set(input.classSessionIds);
    if ([...chosen].some((c) => !coveredIds.has(c))) {
      throw new BadRequestException({
        code: 'NOT_COVERED',
        message: 'Only classes in this request can be excused.',
      });
    }
    const now = this.clock.now();
    const recordOf = new Map(
      await Promise.all(
        [...chosen].map(async (c) => [c, await this.records.forStudentClass(request.studentId, c)] as const),
      ),
    );
    const applied: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, request, OPEN, {
        status: 'APPROVED',
        decidedById: actor.userId,
        decidedAt: now,
        decisionNote: input.note ?? null,
      });
      for (const c of covered) {
        await tx.excuseRequestClass.update({
          where: {
            excuseRequestId_classSessionId: { excuseRequestId: id, classSessionId: c.classSessionId },
          },
          data: { included: chosen.has(c.classSessionId) },
        });
      }
      for (const classSessionId of chosen) {
        const record = recordOf.get(classSessionId);
        if (!record || !isExcusable(record.status)) continue; // attended, waiting, or not recorded yet
        await this.applyInTx(tx, id, classSessionId, record.id, actor.userId, now);
        applied.push(record.id);
      }
      await this.audit.record(
        auditEntry(
          actor,
          'excuses.approved',
          { type: 'excuse_request', id },
          {
            after: { excused: chosen.size, of: covered.length, appliedNow: applied.length },
            reason: input.note,
          },
          context,
        ),
        tx,
      );
    });
    for (const recordId of applied) await this.records.announce(recordId);
    await this.notifyStudent(request.studentId, {
      category: 'EXCUSE_DECIDED',
      title: 'Your excuse request was approved',
      body: `${chosen.size} of ${covered.length} class${covered.length === 1 ? '' : 'es'} excused. Excused classes are not counted in your attendance.${input.note ? ` Note: ${input.note}` : ''}`,
      id,
      key: `excuse-decided:${id}`,
    });
    return this.view(await this.find(id));
  }

  async reject(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof RejectExcuseSchema>,
    context: RequestContext,
  ) {
    const request = await this.reviewable(actor, id);
    if (!OPEN.includes(request.status))
      throw conflict('ALREADY_DECIDED', 'This excuse request is already closed.');
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, request, OPEN, {
        status: 'REJECTED',
        decidedById: actor.userId,
        decidedAt: this.clock.now(),
        decisionNote: input.note,
      });
      await this.audit.record(
        auditEntry(
          actor,
          'excuses.rejected',
          { type: 'excuse_request', id },
          { reason: input.note },
          context,
        ),
        tx,
      );
    });
    await this.notifyStudent(request.studentId, {
      category: 'EXCUSE_DECIDED',
      title: 'Your excuse request was not approved',
      body: `Your records stay as they are. Note: ${input.note}`,
      id,
      key: `excuse-decided:${id}`,
    });
    return this.view(await this.find(id));
  }

  // ───────── Reading ─────────

  /** Students: their own. Administrators: requests from students in their scope. Lecturers: never. */
  async list(actor: AccessClaims, state: 'OPEN' | 'DECIDED' | 'ALL') {
    const where: Prisma.ExcuseRequestWhereInput =
      state === 'OPEN'
        ? { status: { in: OPEN } }
        : state === 'DECIDED'
          ? { status: { in: ['APPROVED', 'REJECTED'] } }
          : {};
    if (actor.role === 'STUDENT') {
      const studentId = await this.ownStudentId(actor);
      const rows = await this.prisma.excuseRequest.findMany({
        where: { ...where, studentId },
        orderBy: { submittedAt: 'desc' },
        take: 200,
      });
      return { data: await Promise.all(rows.map((r) => this.summary(r))) };
    }
    this.assertAdmin(actor);
    const rows = await this.prisma.excuseRequest.findMany({
      where,
      orderBy: { submittedAt: state === 'OPEN' ? 'asc' : 'desc' },
      take: 500,
    });
    const visible: ExcuseRequest[] = [];
    for (const r of rows) if (await this.inScope(actor, r.studentId)) visible.push(r);
    return { data: await Promise.all(visible.map((r) => this.summary(r))) };
  }

  async get(actor: AccessClaims, id: string) {
    return this.view(await this.visible(actor, id));
  }

  async attachmentLink(actor: AccessClaims, id: string, fileId: string) {
    await this.visible(actor, id);
    const attached = await this.prisma.excuseAttachment.findUnique({
      where: { excuseRequestId_fileId: { excuseRequestId: id, fileId } },
    });
    if (!attached)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such file on this request.' });
    return this.files.downloadLink(fileId);
  }

  // ───────── Classes recorded after approval (server time) ─────────

  /**
   * For approved requests, excuses each included class whose record now exists and is absent or
   * rejected (for example attendance closed after the approval). Each change has a correction and an
   * audit entry. Safe to run repeatedly: a class is applied once.
   */
  async applyApproved(): Promise<{ applied: number }> {
    const waiting = await this.prisma.excuseRequestClass.findMany({
      where: { included: true, appliedAt: null, request: { status: 'APPROVED' } },
      include: { request: { select: { studentId: true, decidedById: true } } },
      take: 1000,
    });
    let applied = 0;
    for (const item of waiting) {
      const record = await this.records.forStudentClass(item.request.studentId, item.classSessionId);
      if (!record || !isExcusable(record.status) || !item.request.decidedById) continue;
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.applyInTx(
            tx,
            item.excuseRequestId,
            item.classSessionId,
            record.id,
            item.request.decidedById!,
            this.clock.now(),
          );
          await this.audit.record(
            {
              action: 'excuses.applied',
              entityType: 'excuse_request',
              entityId: item.excuseRequestId,
              after: { classSessionId: item.classSessionId, recordId: record.id },
            },
            tx,
          );
        });
      } catch (error) {
        // The record changed between reading and writing; the next run looks again.
        if (error instanceof ConflictException) continue;
        throw error;
      }
      await this.records.announce(record.id);
      applied++;
    }
    if (applied > 0) this.logger.log(`Excused ${applied} class record(s) from approved requests.`);
    return { applied };
  }

  // ───────── Helpers ─────────

  /** Marks the class applied (once) and sets the record to EXCUSED through the attendance module. */
  private async applyInTx(
    tx: Prisma.TransactionClient,
    excuseRequestId: string,
    classSessionId: string,
    recordId: string,
    actorId: string,
    at: Date,
  ) {
    const claimed = await tx.excuseRequestClass.updateMany({
      where: { excuseRequestId, classSessionId, included: true, appliedAt: null },
      data: { appliedAt: at },
    });
    if (claimed.count !== 1) throw conflict('ALREADY_APPLIED', 'This class was already excused.');
    await this.records.changeForRequest(tx, {
      recordId,
      allowedFrom: EXCUSABLE_STATUSES,
      to: 'EXCUSED',
      reason: CORRECTION_REASON,
      source: 'EXCUSE',
      sourceId: excuseRequestId,
      actorId,
      at,
    });
  }

  /**
   * The student's classes between two dates (in the university's time zone), in sections they were
   * enrolled in at the time, that were not cancelled or moved. Oldest first.
   */
  private async classesIn(studentId: string, startDate: string, endDate: string) {
    const tz = this.config.institutionTimezone;
    const from = wallClockToUtc(startDate, 0, tz);
    const to = wallClockToUtc(endDate, 24 * 60, tz);
    const enrolments = await this.enrollments.enrolmentsOf(studentId);
    const classes = await this.classSessions.forSections(enrolments.map((e) => e.sectionId));
    return classes.filter(
      (c) =>
        c.scheduledStart >= from &&
        c.scheduledStart < to &&
        !NOT_HELD.includes(c.status) &&
        enrolments.some(
          (e) =>
            c.sectionIds.includes(e.sectionId) &&
            e.enrolledAt <= c.scheduledStart &&
            (!e.endedAt || e.endedAt > c.scheduledStart),
        ),
    );
  }

  private async find(id: string): Promise<ExcuseRequest> {
    const request = await this.prisma.excuseRequest.findUnique({ where: { id } });
    if (!request) throw notFound();
    return request;
  }

  private async ownStudentId(actor: AccessClaims): Promise<string> {
    const studentId = actor.role === 'STUDENT' ? await this.students.idForUser(actor.userId) : null;
    if (!studentId)
      throw new ForbiddenException({ code: 'NOT_A_STUDENT', message: 'Only students can do this.' });
    return studentId;
  }

  private async ownRequest(actor: AccessClaims, id: string): Promise<ExcuseRequest> {
    const studentId = await this.ownStudentId(actor);
    const request = await this.find(id);
    if (request.studentId !== studentId) throw notFound();
    return request;
  }

  /** Lecturers never see excuse requests (D-22); only administrators decide them. */
  private assertAdmin(actor: AccessClaims) {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'UNIVERSITY_ADMIN') {
      throw new ForbiddenException({
        code: 'ADMINISTRATORS_ONLY',
        message:
          'Excuse requests are decided by administrators. Lecturers see only that a class was excused.',
      });
    }
  }

  private async departmentOf(studentId: string) {
    const student = await this.students.get(studentId);
    return { id: student.department.id, facultyId: student.faculty.id };
  }

  private async inScope(actor: AccessClaims, studentId: string): Promise<boolean> {
    try {
      await this.access.assertDepartment(actor, await this.departmentOf(studentId));
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /** An administrator whose scope covers the student's department; anyone else gets 403 or 404. */
  private async reviewable(actor: AccessClaims, id: string): Promise<ExcuseRequest> {
    this.assertAdmin(actor);
    const request = await this.find(id);
    if (!(await this.inScope(actor, request.studentId))) throw notFound();
    return request;
  }

  /** The student who sent it, or an administrator in scope. */
  private async visible(actor: AccessClaims, id: string): Promise<ExcuseRequest> {
    if (actor.role === 'STUDENT') return this.ownRequest(actor, id);
    return this.reviewable(actor, id);
  }

  private async move(
    tx: Prisma.TransactionClient,
    request: ExcuseRequest,
    from: ExcuseStatus[],
    data: Prisma.ExcuseRequestUncheckedUpdateManyInput,
  ) {
    const claimed = await tx.excuseRequest.updateMany({
      where: { id: request.id, status: { in: from } },
      data,
    });
    if (claimed.count !== 1) {
      throw conflict('REQUEST_CHANGED', 'This excuse request changed a moment ago. Reload and try again.');
    }
  }

  private async notifyStudent(
    studentId: string,
    n: {
      category: 'EXCUSE_INFO_REQUESTED' | 'EXCUSE_DECIDED';
      title: string;
      body: string;
      id: string;
      key: string;
    },
  ) {
    const userId = (await this.students.summaries([studentId])).get(studentId)?.userId;
    if (!userId) return;
    await this.notifications.notify({
      userIds: [userId],
      category: n.category,
      title: n.title,
      body: n.body,
      data: { path: `/requests/excuses/${n.id}` },
      related: { type: 'excuse_request', id: n.id },
      dedupeKey: n.key,
    });
  }

  private async summary(r: ExcuseRequest) {
    const person = (await this.students.summaries([r.studentId])).get(r.studentId);
    const classes = await this.prisma.excuseRequestClass.findMany({ where: { excuseRequestId: r.id } });
    return {
      id: r.id,
      status: r.status,
      category: r.category,
      description: r.description,
      startDate: isoDay(r.startDate),
      endDate: isoDay(r.endDate),
      submittedAt: r.submittedAt,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      classCount: classes.length,
      excusedCount: classes.filter((c) => c.included).length,
      student: person
        ? { id: person.id, studentNumber: person.studentNumber, fullName: person.fullName }
        : { id: r.studentId, studentNumber: '', fullName: '' },
    };
  }

  /** One request in full: the classes covered (with each record's status now), the conversation and the files. */
  private async view(r: ExcuseRequest) {
    const [summary, items, messages, attachments] = await Promise.all([
      this.summary(r),
      this.prisma.excuseRequestClass.findMany({ where: { excuseRequestId: r.id } }),
      this.prisma.excuseMessage.findMany({
        where: { excuseRequestId: r.id },
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { fullName: true } } },
      }),
      this.prisma.excuseAttachment.findMany({
        where: { excuseRequestId: r.id },
        orderBy: { addedAt: 'asc' },
        include: { file: { select: { originalName: true, mimeType: true, sizeBytes: true } } },
      }),
    ]);
    const classes = await this.classSessions.facts(items.map((i) => i.classSessionId));
    const sections = await this.courses.sectionSummaries([...classes.values()].flatMap((c) => c.sectionIds));
    const records = await Promise.all(
      items.map((i) => this.records.forStudentClass(r.studentId, i.classSessionId)),
    );
    return {
      ...summary,
      classes: items
        .map((i, n) => {
          const cls = classes.get(i.classSessionId);
          const section = cls ? sections.get(cls.sectionIds[0] ?? '') : undefined;
          return {
            classSessionId: i.classSessionId,
            scheduledStart: cls?.scheduledStart ?? null,
            course: section ? { code: section.course.code, title: section.course.title } : null,
            included: i.included,
            appliedAt: i.appliedAt,
            recordStatus: records[n]?.status ?? null,
          };
        })
        .sort((a, b) => (a.scheduledStart?.getTime() ?? 0) - (b.scheduledStart?.getTime() ?? 0)),
      messages: messages.map((m) => ({ kind: m.kind, body: m.body, by: m.author.fullName, at: m.createdAt })),
      attachments: attachments.map((a) => ({
        fileId: a.fileId,
        name: a.file.originalName,
        mimeType: a.file.mimeType,
        sizeBytes: a.file.sizeBytes,
        addedAt: a.addedAt,
      })),
    };
  }
}

function isExcusable(status: string): boolean {
  return (EXCUSABLE_STATUSES as readonly string[]).includes(status);
}

function label(category: string): string {
  return category.toLowerCase().replaceAll('_', ' ');
}
