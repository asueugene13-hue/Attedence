import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type ApproveDisputeSchema,
  DISPUTABLE_STATUSES,
  DISPUTE_ESCALATE_AFTER_HOURS,
  type DisputeStatus,
  OPEN_DISPUTE_STATUSES,
  type RejectDisputeSchema,
  REQUEST_ATTACHMENT_LIMITS,
  type SubmitDisputeSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { dbErrorInfo, PG } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { unsupportedFile, type UploadedBytes } from '../../common/upload.js';
import type { AttendanceDispute, Prisma } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AttendanceRecordsService } from '../attendance/records.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { ClassSessionsService } from '../class-sessions/class-sessions.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { detectFileType } from '../files/file-type.js';
import { FilesService } from '../files/files.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StudentsService } from '../students/students.service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OPEN: DisputeStatus[] = [...OPEN_DISPUTE_STATUSES];
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such dispute.' });

type Dispute = AttendanceDispute;

/**
 * Attendance disputes (ATTENDANCE_FLOW §7; Phase 6 step 2; decision D-21). A student disputes their own
 * absent or rejected record, after attendance closed and within the dispute window. The class's lecturer
 * (or an administrator in scope) may ask questions, approve (the record becomes present or late, through
 * the attendance module, with a correction and an audit entry) or reject with a note. The student may
 * withdraw. A dispute waiting for a reviewer for 72 hours is passed to the administrators responsible,
 * once. Nothing is decided automatically, and the record never changes until someone decides.
 */
@Injectable()
export class DisputesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly jobs: JobRegistry,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly students: StudentsService,
    private readonly records: AttendanceRecordsService,
    private readonly classSessions: ClassSessionsService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
  ) {}

  onModuleInit(): void {
    this.jobs.define({
      queue: 'monitoring',
      name: 'disputes-waiting',
      attempts: 3,
      handle: async () => {
        await this.escalateWaiting();
      },
    });
    this.jobs.every('monitoring', 'disputes-waiting', 15 * 60_000);
  }

  // ───────── The student ─────────

  async submit(actor: AccessClaims, input: z.output<typeof SubmitDisputeSchema>, context: RequestContext) {
    const studentId = await this.ownStudentId(actor);
    const record = await this.records.forStudentClass(studentId, input.classSessionId);
    if (!record) {
      throw conflict(
        'NO_RECORD',
        'There is no attendance record for you in this class, so there is nothing to dispute.',
      );
    }
    if (!record.attendanceClosed) {
      throw conflict(
        'ATTENDANCE_STILL_OPEN',
        'Attendance for this class is still open. Try checking in again, or ask your lecturer.',
      );
    }
    if (!(DISPUTABLE_STATUSES as readonly string[]).includes(record.status)) {
      throw conflict(
        'NOT_DISPUTABLE',
        `Only absent or rejected records can be disputed; this one is ${record.status.toLowerCase()}.`,
      );
    }
    const cls = (await this.classSessions.facts([record.classSessionId])).get(record.classSessionId);
    if (!cls) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such class session.' });
    const days = await this.settings.get('requests.disputeDays');
    const now = this.clock.now();
    if (now.getTime() > cls.scheduledStart.getTime() + days * DAY) {
      throw conflict(
        'DISPUTE_WINDOW_PASSED',
        `Disputes are accepted for ${days} days after a class. Ask your lecturer or an administrator if something is wrong.`,
      );
    }
    let dispute: Dispute;
    try {
      dispute = await this.prisma.$transaction(async (tx) => {
        const created = await tx.attendanceDispute.create({
          data: {
            recordId: record.id,
            studentId,
            reason: input.reason,
            recordStatus: record.status,
            submittedAt: now,
            waitingSince: now,
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'disputes.submitted',
            { type: 'attendance_dispute', id: created.id },
            { after: { recordId: record.id, recordStatus: record.status }, reason: input.reason },
            context,
          ),
          tx,
        );
        return created;
      });
    } catch (error) {
      if (dbErrorInfo(error)?.pgCode === PG.uniqueViolation) {
        throw conflict('DISPUTE_OPEN', 'You already have an open dispute for this class.');
      }
      throw error;
    }
    await this.notifyLecturer(dispute, cls.id, cls.lecturerId);
    return this.view(dispute);
  }

  /** Adds a supporting file (PDF, JPEG or PNG, checked from its bytes) while the dispute is open. */
  async attach(actor: AccessClaims, id: string, upload: UploadedBytes, context: RequestContext) {
    const dispute = await this.ownDispute(actor, id);
    if (!OPEN.includes(dispute.status)) throw conflict('NOT_OPEN', 'This dispute is closed.');
    const count = await this.prisma.disputeAttachment.count({ where: { disputeId: id } });
    if (count >= REQUEST_ATTACHMENT_LIMITS.maxFiles) {
      throw conflict('TOO_MANY_FILES', `At most ${REQUEST_ATTACHMENT_LIMITS.maxFiles} files per dispute.`);
    }
    const type = detectFileType(upload.buffer);
    if (!type || !(REQUEST_ATTACHMENT_LIMITS.types as readonly string[]).includes(type)) {
      throw unsupportedFile('a PDF, JPEG or PNG file');
    }
    const stored = await this.files.store({
      purpose: 'REQUEST_ATTACHMENT',
      bytes: upload.buffer,
      mimeType: type,
      originalName: upload.originalname,
      uploadedById: actor.userId,
    });
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.disputeAttachment.create({
          data: { disputeId: id, fileId: stored.id, addedAt: this.clock.now() },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'disputes.attachment_added',
            { type: 'attendance_dispute', id },
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
    const dispute = await this.ownDispute(actor, id);
    if (dispute.status !== 'INFO_REQUESTED') {
      throw conflict('NO_QUESTION', 'Nobody is waiting for an answer on this dispute.');
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, dispute, ['INFO_REQUESTED'], { status: 'SUBMITTED', waitingSince: now });
      await tx.disputeMessage.create({
        data: { disputeId: id, kind: 'REPLY', body: reply, authorId: actor.userId, createdAt: now },
      });
      await this.audit.record(
        auditEntry(actor, 'disputes.replied', { type: 'attendance_dispute', id }, { reason: reply }, context),
        tx,
      );
    });
    const asker = await this.prisma.disputeMessage.findFirst({
      where: { disputeId: id, kind: 'QUESTION' },
      orderBy: { createdAt: 'desc' },
    });
    if (asker) {
      await this.notifications.notify({
        userIds: [asker.authorId],
        category: 'DISPUTE_REPLIED',
        title: 'A student answered your question',
        body: `The student replied about their attendance dispute: ${reply}`,
        data: { path: `/reviews?dispute=${id}` },
        related: { type: 'attendance_dispute', id },
        dedupeKey: `dispute-replied:${id}:${now.getTime()}`,
      });
    }
    return this.view(await this.find(id));
  }

  async withdraw(actor: AccessClaims, id: string, context: RequestContext) {
    const dispute = await this.ownDispute(actor, id);
    if (!OPEN.includes(dispute.status)) throw conflict('NOT_OPEN', 'This dispute is already closed.');
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, dispute, OPEN, { status: 'WITHDRAWN', waitingSince: null });
      await this.audit.record(
        auditEntry(actor, 'disputes.withdrawn', { type: 'attendance_dispute', id }, {}, context),
        tx,
      );
    });
    return this.view(await this.find(id));
  }

  // ───────── The reviewer (the class's lecturer, or an administrator in scope) ─────────

  async ask(actor: AccessClaims, id: string, question: string, context: RequestContext) {
    const dispute = await this.find(id);
    await this.records.authorizeReview(actor, dispute.recordId, 'requests.review');
    if (dispute.status !== 'SUBMITTED') {
      throw conflict(
        dispute.status === 'INFO_REQUESTED' ? 'WAITING_FOR_STUDENT' : 'NOT_OPEN',
        dispute.status === 'INFO_REQUESTED'
          ? 'The student has not answered the last question yet.'
          : 'This dispute is closed.',
      );
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, dispute, ['SUBMITTED'], { status: 'INFO_REQUESTED', waitingSince: null });
      await tx.disputeMessage.create({
        data: { disputeId: id, kind: 'QUESTION', body: question, authorId: actor.userId, createdAt: now },
      });
      await this.audit.record(
        auditEntry(
          actor,
          'disputes.info_requested',
          { type: 'attendance_dispute', id },
          { reason: question },
          context,
        ),
        tx,
      );
    });
    await this.notifyStudent(dispute.studentId, {
      category: 'DISPUTE_INFO_REQUESTED',
      title: 'A question about your attendance dispute',
      body: `Your reviewer asks: ${question} Reply in the app; the dispute waits for your answer.`,
      id,
      key: `dispute-question:${id}:${now.getTime()}`,
    });
    return this.view(await this.find(id));
  }

  async approve(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof ApproveDisputeSchema>,
    context: RequestContext,
  ) {
    const dispute = await this.find(id);
    await this.records.authorizeReview(actor, dispute.recordId, 'requests.review');
    if (!OPEN.includes(dispute.status)) throw conflict('ALREADY_DECIDED', 'This dispute is already closed.');
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, dispute, OPEN, {
        status: 'APPROVED',
        outcome: input.status,
        decidedById: actor.userId,
        decidedAt: now,
        decisionNote: input.note ?? null,
        waitingSince: null,
      });
      const { from } = await this.records.changeForRequest(tx, {
        recordId: dispute.recordId,
        allowedFrom: DISPUTABLE_STATUSES,
        to: input.status,
        reason: `Dispute approved. Student: ${dispute.reason}${input.note ? ` Reviewer: ${input.note}` : ''}`,
        source: 'DISPUTE',
        sourceId: id,
        actorId: actor.userId,
        at: now,
      });
      await this.audit.record(
        auditEntry(
          actor,
          'disputes.approved',
          { type: 'attendance_dispute', id },
          {
            before: { recordStatus: from },
            after: { recordStatus: input.status, recordId: dispute.recordId },
            reason: input.note,
          },
          context,
        ),
        tx,
      );
    });
    await this.records.announce(dispute.recordId);
    await this.notifyStudent(dispute.studentId, {
      category: 'DISPUTE_DECIDED',
      title: 'Your attendance dispute was approved',
      body: `Your record is now ${input.status.toLowerCase()}.${input.note ? ` Note: ${input.note}` : ''}`,
      id,
      key: `dispute-decided:${id}`,
    });
    return this.view(await this.find(id));
  }

  async reject(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof RejectDisputeSchema>,
    context: RequestContext,
  ) {
    const dispute = await this.find(id);
    await this.records.authorizeReview(actor, dispute.recordId, 'requests.review');
    if (!OPEN.includes(dispute.status)) throw conflict('ALREADY_DECIDED', 'This dispute is already closed.');
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, dispute, OPEN, {
        status: 'REJECTED',
        decidedById: actor.userId,
        decidedAt: now,
        decisionNote: input.note,
        waitingSince: null,
      });
      await this.audit.record(
        auditEntry(
          actor,
          'disputes.rejected',
          { type: 'attendance_dispute', id },
          { reason: input.note },
          context,
        ),
        tx,
      );
    });
    await this.notifyStudent(dispute.studentId, {
      category: 'DISPUTE_DECIDED',
      title: 'Your attendance dispute was not approved',
      body: `Your record stays as it was. Note: ${input.note}`,
      id,
      key: `dispute-decided:${id}`,
    });
    return this.view(await this.find(id));
  }

  // ───────── Reading ─────────

  /**
   * Students: their own disputes. Lecturers: disputes about their classes. Administrators: disputes
   * about classes in their scope. Oldest first while open (the order to decide them in).
   */
  async list(actor: AccessClaims, state: 'OPEN' | 'DECIDED' | 'ALL') {
    const where: Prisma.AttendanceDisputeWhereInput =
      state === 'OPEN'
        ? { status: { in: OPEN } }
        : state === 'DECIDED'
          ? { status: { in: ['APPROVED', 'REJECTED'] } }
          : {};
    if (actor.role === 'STUDENT') {
      const studentId = await this.ownStudentId(actor);
      const rows = await this.prisma.attendanceDispute.findMany({
        where: { ...where, studentId },
        orderBy: { submittedAt: 'desc' },
        take: 200,
      });
      return { data: await this.summaries(rows) };
    }
    const rows = await this.prisma.attendanceDispute.findMany({
      where,
      orderBy: { submittedAt: state === 'OPEN' ? 'asc' : 'desc' },
      take: 500,
    });
    const visible: Dispute[] = [];
    for (const row of rows) if (await this.mayReview(actor, row)) visible.push(row);
    return { data: await this.summaries(visible) };
  }

  async get(actor: AccessClaims, id: string) {
    const dispute = await this.find(id);
    await this.assertMaySee(actor, dispute);
    return this.view(dispute);
  }

  /** A short-lived link to an attached file, for the student and the reviewers. */
  async attachmentLink(actor: AccessClaims, id: string, fileId: string) {
    const dispute = await this.find(id);
    await this.assertMaySee(actor, dispute);
    const attached = await this.prisma.disputeAttachment.findUnique({
      where: { disputeId_fileId: { disputeId: id, fileId } },
    });
    if (!attached)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such file on this dispute.' });
    return this.files.downloadLink(fileId);
  }

  // ───────── Waiting too long (server time) ─────────

  /**
   * Disputes waiting for a reviewer for 72 hours: the administrators responsible are told, once. The
   * lecturer can still decide; nothing is decided or changed here. Safe to run repeatedly.
   */
  async escalateWaiting(): Promise<{ escalated: number }> {
    const now = this.clock.now();
    const due = await this.prisma.attendanceDispute.findMany({
      where: {
        status: 'SUBMITTED',
        escalatedAt: null,
        waitingSince: { lte: new Date(now.getTime() - DISPUTE_ESCALATE_AFTER_HOURS * HOUR) },
      },
    });
    let escalated = 0;
    const facts = await this.records.facts(due.map((d) => d.recordId));
    for (const d of due) {
      const claimed = await this.prisma.attendanceDispute.updateMany({
        where: { id: d.id, escalatedAt: null, status: 'SUBMITTED' },
        data: { escalatedAt: now },
      });
      if (claimed.count !== 1) continue;
      await this.audit.record({
        action: 'disputes.escalated',
        entityType: 'attendance_dispute',
        entityId: d.id,
        after: { waitingSince: d.waitingSince },
      });
      const record = facts.get(d.recordId);
      if (record) {
        await this.notifications.notify({
          userIds: await this.records.adminsFor(record.classSessionId),
          category: 'DISPUTE_ESCALATED',
          priority: 'HIGH',
          title: `An attendance dispute has waited ${DISPUTE_ESCALATE_AFTER_HOURS} hours`,
          body: 'The lecturer has not decided a student’s attendance dispute. Please decide it; the record does not change until someone does.',
          data: { path: `/reviews?dispute=${d.id}` },
          related: { type: 'attendance_dispute', id: d.id },
          dedupeKey: `dispute-escalated:${d.id}`,
        });
      }
      escalated++;
    }
    return { escalated };
  }

  // ───────── Helpers ─────────

  private async find(id: string): Promise<Dispute> {
    const dispute = await this.prisma.attendanceDispute.findUnique({ where: { id } });
    if (!dispute) throw notFound();
    return dispute;
  }

  private async ownStudentId(actor: AccessClaims): Promise<string> {
    const studentId = actor.role === 'STUDENT' ? await this.students.idForUser(actor.userId) : null;
    if (!studentId) {
      throw new ForbiddenException({ code: 'NOT_A_STUDENT', message: 'Only students can do this.' });
    }
    return studentId;
  }

  /** The student's own dispute; another student's is reported as not found. */
  private async ownDispute(actor: AccessClaims, id: string): Promise<Dispute> {
    const studentId = await this.ownStudentId(actor);
    const dispute = await this.find(id);
    if (dispute.studentId !== studentId) throw notFound();
    return dispute;
  }

  private async mayReview(actor: AccessClaims, dispute: Dispute): Promise<boolean> {
    try {
      await this.records.authorizeReview(actor, dispute.recordId, 'requests.review');
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  private async assertMaySee(actor: AccessClaims, dispute: Dispute) {
    if (actor.role === 'STUDENT') {
      if ((await this.students.idForUser(actor.userId)) !== dispute.studentId) throw notFound();
      return;
    }
    if (!(await this.mayReview(actor, dispute))) throw notFound();
  }

  /** Changes the dispute only if it is still in one of `from` (another decision did not get there first). */
  private async move(
    tx: Prisma.TransactionClient,
    dispute: Dispute,
    from: DisputeStatus[],
    data: Prisma.AttendanceDisputeUncheckedUpdateManyInput,
  ) {
    const claimed = await tx.attendanceDispute.updateMany({
      where: { id: dispute.id, status: { in: from } },
      data,
    });
    if (claimed.count !== 1) {
      throw conflict('DISPUTE_CHANGED', 'This dispute changed a moment ago. Reload and try again.');
    }
  }

  private async notifyLecturer(dispute: Dispute, classSessionId: string, lecturerId: string) {
    const userId = (await this.lecturers.facts([lecturerId])).get(lecturerId)?.userId;
    if (!userId) return;
    await this.notifications.notify({
      userIds: [userId],
      category: 'DISPUTE_SUBMITTED',
      title: 'A student disputes their attendance',
      body: `A student says their record for one of your classes is wrong: ${dispute.reason}`,
      data: { path: `/reviews?dispute=${dispute.id}` },
      related: { type: 'attendance_dispute', id: dispute.id },
      dedupeKey: `dispute-submitted:${dispute.id}:${classSessionId}`,
    });
  }

  private async notifyStudent(
    studentId: string,
    n: {
      category: 'DISPUTE_INFO_REQUESTED' | 'DISPUTE_DECIDED';
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
      data: { path: `/requests/disputes/${n.id}` },
      related: { type: 'attendance_dispute', id: n.id },
      dedupeKey: n.key,
    });
  }

  /** List rows: the dispute with its class, course and student. */
  private async summaries(rows: Dispute[]) {
    const records = await this.records.facts(rows.map((r) => r.recordId));
    const classes = await this.classSessions.facts([...records.values()].map((r) => r.classSessionId));
    const sections = await this.courses.sectionSummaries([...classes.values()].flatMap((c) => c.sectionIds));
    const people = await this.students.summaries(rows.map((r) => r.studentId));
    return rows.map((d) => {
      const record = records.get(d.recordId);
      const cls = record ? classes.get(record.classSessionId) : undefined;
      const section = cls ? sections.get(cls.sectionIds[0] ?? '') : undefined;
      const person = people.get(d.studentId);
      return {
        id: d.id,
        status: d.status,
        reason: d.reason,
        submittedAt: d.submittedAt,
        waitingSince: d.waitingSince,
        escalatedAt: d.escalatedAt,
        decidedAt: d.decidedAt,
        outcome: d.outcome,
        decisionNote: d.decisionNote,
        record: { id: d.recordId, statusWhenDisputed: d.recordStatus, status: record?.status ?? null },
        class: cls
          ? {
              id: cls.id,
              scheduledStart: cls.scheduledStart,
              scheduledEnd: cls.scheduledEnd,
              course: section ? { code: section.course.code, title: section.course.title } : null,
              sectionCodes: cls.sectionIds.map((s) => sections.get(s)?.code).filter(Boolean),
            }
          : null,
        student: person
          ? { id: person.id, studentNumber: person.studentNumber, fullName: person.fullName }
          : { id: d.studentId, studentNumber: '', fullName: '' },
      };
    });
  }

  /** One dispute in full: the summary, the conversation, the files and the check-in attempts. */
  private async view(dispute: Dispute) {
    const [summary] = await this.summaries([dispute]);
    const [messages, attachments, attempts] = await Promise.all([
      this.prisma.disputeMessage.findMany({
        where: { disputeId: dispute.id },
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { fullName: true } } },
      }),
      this.prisma.disputeAttachment.findMany({
        where: { disputeId: dispute.id },
        orderBy: { addedAt: 'asc' },
        include: { file: { select: { originalName: true, mimeType: true, sizeBytes: true } } },
      }),
      this.records.attemptsFor(dispute.recordId),
    ]);
    return {
      ...summary!,
      messages: messages.map((m) => ({ kind: m.kind, body: m.body, by: m.author.fullName, at: m.createdAt })),
      attachments: attachments.map((a) => ({
        fileId: a.fileId,
        name: a.file.originalName,
        mimeType: a.file.mimeType,
        sizeBytes: a.file.sizeBytes,
        addedAt: a.addedAt,
      })),
      attempts,
    };
  }
}
