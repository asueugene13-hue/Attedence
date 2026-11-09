import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CLASS_ACTIONS, toMinutes } from '@attendsure/shared';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { dayIn, wallClockToUtc } from '../../common/time-zone.js';
import { AppConfig } from '../../config/app-config.js';
import type {
  ClassSession,
  Prisma,
  RescheduleRequest,
  RescheduleStatus,
} from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { PlacesService } from '../places/places.service.js';
import { ClassEventService } from './class-event.service.js';
import { ClassSessionsService } from './class-sessions.service.js';

export interface Proposal {
  date: string;
  startTime: string;
  endTime: string;
  classroomId: string;
}

export interface Finding {
  code: string;
  message: string;
  [detail: string]: unknown;
}

type SessionWithSections = ClassSession & { sections: { sectionId: string }[] };

const ADMIN_ROLES = ['SUPER_ADMIN', 'UNIVERSITY_ADMIN'];
/** Statuses a class can be rescheduled from: not started yet (or on hold). */
const RESCHEDULABLE: readonly string[] = CLASS_ACTIONS.reschedule.adminFrom;
const LIVE = { notIn: ['CANCELLED', 'RESCHEDULED'] as ClassSession['status'][] };
const SLOT_TAKEN = {
  class_sessions_room_no_overlap: {
    code: 'SLOT_TAKEN',
    message: 'The room was booked at that time a moment ago.',
  },
  class_sessions_lecturer_no_overlap: {
    code: 'SLOT_TAKEN',
    message: 'The lecturer was given another class at that time a moment ago.',
  },
};
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'No such reschedule request.' });
const alreadyDecided = () =>
  new ConflictException({ code: 'ALREADY_DECIDED', message: 'This request has already been decided.' });

/**
 * Rescheduling a class (D-11, CLASS_LIFECYCLE.md §5). The class's lecturer asks for a new time and
 * room; an administrator within scope approves or rejects it after seeing the conflict check; in
 * exceptional cases an administrator reschedules directly, with a reason. Approval creates the
 * replacement session and marks the original RESCHEDULED in one transaction, through
 * ClassEventService (the only code that changes a class's status). The original is kept for history.
 */
@Injectable()
export class RescheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: ClassEventService,
    private readonly sessions: ClassSessionsService,
    private readonly permissions: PermissionService,
    private readonly access: AcademicAccessService,
    private readonly academic: AcademicLookupsService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly places: PlacesService,
    private readonly enrollments: EnrollmentsService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** The conflict check for a proposed time and room, without saving anything. */
  async check(actor: AccessClaims, sessionId: string, proposal: Proposal) {
    const session = await this.session(sessionId);
    await this.assertMayPropose(actor, session);
    const { start, end } = this.times(proposal);
    return {
      proposedStart: start,
      proposedEnd: end,
      ...(await this.findings(session, start, end, proposal.classroomId)),
    };
  }

  /** A lecturer asks to move their own class. Refused if something blocks the new time. */
  async request(
    actor: AccessClaims,
    sessionId: string,
    input: Proposal & { reason: string },
    context: RequestContext,
  ) {
    const session = await this.session(sessionId);
    if (actor.role !== 'LECTURER') {
      throw new ForbiddenException({
        code: 'LECTURERS_ONLY',
        message: 'Only the class’s lecturer can ask for a reschedule. Administrators reschedule directly.',
      });
    }
    await this.assertMayPropose(actor, session);
    this.assertReschedulable(session);
    const { start, end } = this.times(input);
    const found = await this.findings(session, start, end, input.classroomId);
    this.assertNoBlockers(found);
    const created = await this.prisma
      .$transaction(async (tx) => {
        const row = await tx.rescheduleRequest.create({
          data: {
            classSessionId: session.id,
            requestedById: actor.userId,
            proposedStart: start,
            proposedEnd: end,
            proposedClassroomId: input.classroomId,
            reason: input.reason,
            createdAt: this.clock.now(),
          },
        });
        await this.audit.record(
          auditEntry(
            actor,
            'reschedule_requests.created',
            { type: 'reschedule_request', id: row.id },
            { after: this.auditView(row), reason: input.reason },
            context,
          ),
          tx,
        );
        return row;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          reschedule_requests_one_pending: {
            code: 'REQUEST_PENDING',
            message: 'There is already a reschedule request waiting for this class.',
          },
        }),
      );
    return { ...(await this.view(created)), warnings: found.warnings };
  }

  /**
   * Lecturers see their own requests; administrators the requests for classes within their scope.
   * Newest first.
   */
  async list(actor: AccessClaims, status?: RescheduleStatus) {
    const isAdmin = await this.isDecider(actor);
    if (!isAdmin && actor.role !== 'LECTURER') {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to do this.',
      });
    }
    const rows = await this.prisma.rescheduleRequest.findMany({
      where: { ...(status ? { status } : {}), ...(isAdmin ? {} : { requestedById: actor.userId }) },
      include: { classSession: { include: { sections: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const visible = isAdmin ? await this.withinScope(actor, rows) : rows;
    return { data: await this.views(visible) };
  }

  /** One request; while it is pending, with a fresh conflict check. */
  async get(actor: AccessClaims, id: string) {
    const row = await this.findRequest(id);
    const session = await this.session(row.classSessionId);
    if (row.requestedById !== actor.userId) await this.assertDecider(actor, session);
    const [view] = await this.views([row]);
    if (row.status !== 'PENDING') return view!;
    return {
      ...view!,
      check: await this.findings(session, row.proposedStart, row.proposedEnd, row.proposedClassroomId),
    };
  }

  async approve(actor: AccessClaims, id: string, note: string | undefined, context: RequestContext) {
    const row = await this.findRequest(id);
    if (row.status !== 'PENDING') throw alreadyDecided();
    const session = await this.session(row.classSessionId);
    await this.assertDecider(actor, session);
    this.assertNoBlockers(
      await this.findings(session, row.proposedStart, row.proposedEnd, row.proposedClassroomId),
    );

    await this.events
      .act(
        actor,
        session.id,
        'reschedule',
        { reason: note ?? row.reason },
        context,
        async (tx, original, now) => {
          const replacement = await this.createReplacement(tx, actor, original, row, now);
          const decided = await tx.rescheduleRequest.updateMany({
            where: { id: row.id, status: 'PENDING' },
            data: {
              status: 'APPROVED',
              decidedById: actor.userId,
              decidedAt: now,
              decisionNote: note ?? null,
              replacementSessionId: replacement.id,
            },
          });
          if (decided.count !== 1) throw alreadyDecided();
          await this.audit.record(
            auditEntry(
              actor,
              'reschedule_requests.approved',
              { type: 'reschedule_request', id: row.id },
              {
                before: { status: 'PENDING' },
                after: { status: 'APPROVED', replacementSessionId: replacement.id },
                reason: note,
              },
              context,
            ),
            tx,
          );
          return this.eventDetails(row.id, replacement);
        },
      )
      .catch((e: unknown) => rethrowAsConflict(e, SLOT_TAKEN));
    return this.get(actor, id);
  }

  async reject(actor: AccessClaims, id: string, note: string, context: RequestContext) {
    const row = await this.findRequest(id);
    if (row.status !== 'PENDING') throw alreadyDecided();
    await this.assertDecider(actor, await this.session(row.classSessionId));
    await this.close(actor, row, 'REJECTED', note, 'reschedule_requests.rejected', context);
    return this.get(actor, id);
  }

  /** The lecturer who asked takes the request back while it is still pending. */
  async withdraw(actor: AccessClaims, id: string, context: RequestContext) {
    const row = await this.findRequest(id);
    if (row.requestedById !== actor.userId) {
      throw new ForbiddenException({
        code: 'NOT_YOUR_REQUEST',
        message: 'Only the person who asked can withdraw this.',
      });
    }
    if (row.status !== 'PENDING') throw alreadyDecided();
    await this.close(actor, row, 'WITHDRAWN', null, 'reschedule_requests.withdrawn', context);
    return this.get(actor, id);
  }

  /**
   * An administrator moves a class without a request, in exceptional cases (D-11). A reason is
   * required. It is recorded as an approved "direct" request, so every reschedule has one record;
   * a request the lecturer had waiting for the same class is closed as rejected.
   */
  async direct(
    actor: AccessClaims,
    sessionId: string,
    input: Proposal & { reason: string },
    context: RequestContext,
    reviewNote?: string,
  ) {
    const session = await this.session(sessionId);
    await this.assertDecider(actor, session);
    this.assertReschedulable(session);
    const { start, end } = this.times(input);
    this.assertNoBlockers(await this.findings(session, start, end, input.classroomId));

    let requestId = '';
    await this.events
      .act(
        actor,
        session.id,
        'reschedule',
        { reason: input.reason, reviewNote },
        context,
        async (tx, original, now) => {
          await this.closeWaiting(tx, actor, original.id, now, context);
          const row = await tx.rescheduleRequest.create({
            data: {
              classSessionId: original.id,
              requestedById: actor.userId,
              proposedStart: start,
              proposedEnd: end,
              proposedClassroomId: input.classroomId,
              reason: input.reason,
              status: 'PENDING',
              isDirect: true,
              createdAt: now,
            },
          });
          const replacement = await this.createReplacement(tx, actor, original, row, now);
          await tx.rescheduleRequest.update({
            where: { id: row.id },
            data: {
              status: 'APPROVED',
              decidedById: actor.userId,
              decidedAt: now,
              replacementSessionId: replacement.id,
            },
          });
          await this.audit.record(
            auditEntry(
              actor,
              'reschedule_requests.direct',
              { type: 'reschedule_request', id: row.id },
              {
                after: { ...this.auditView(row), status: 'APPROVED', replacementSessionId: replacement.id },
                reason: input.reason,
              },
              context,
            ),
            tx,
          );
          requestId = row.id;
          return this.eventDetails(row.id, replacement);
        },
      )
      .catch((e: unknown) => rethrowAsConflict(e, SLOT_TAKEN));
    return this.get(actor, requestId);
  }

  // ───────── Checks ─────────

  /**
   * What stops the new time (blockers) and what the approver should know (warnings):
   * the room exists and is in use, is free, the lecturer is free, the time is in the future;
   * students with another class then, a day without classes, and a room smaller than the class.
   * The class being moved is ignored, so a class can move within its own slot (for a room change).
   */
  private async findings(session: SessionWithSections, start: Date, end: Date, classroomId: string) {
    const blockers: Finding[] = [];
    const warnings: Finding[] = [];
    const now = this.clock.now();
    if (start <= now) blockers.push({ code: 'IN_THE_PAST', message: 'The new time must be in the future.' });

    const room = (await this.places.classroomFacts([classroomId])).get(classroomId);
    if (!room?.isActive) {
      blockers.push({ code: 'ROOM_UNAVAILABLE', message: 'That room does not exist or is not in use.' });
    }
    const overlapping = {
      id: { not: session.id },
      status: LIVE,
      scheduledStart: { lt: end },
      scheduledEnd: { gt: start },
    };
    const [roomClashes, lecturerClashes, others] = await Promise.all([
      this.prisma.classSession.findMany({ where: { ...overlapping, classroomId }, select: { id: true } }),
      this.prisma.classSession.findMany({
        where: { ...overlapping, lecturerId: session.lecturerId },
        select: { id: true },
      }),
      this.prisma.classSession.findMany({ where: overlapping, include: { sections: true } }),
    ]);
    if (roomClashes.length > 0) {
      blockers.push({
        code: 'ROOM_TAKEN',
        message: 'The room is booked at that time.',
        sessionIds: roomClashes.map((s) => s.id),
      });
    }
    if (lecturerClashes.length > 0) {
      blockers.push({
        code: 'LECTURER_BUSY',
        message: 'The lecturer has another class at that time.',
        sessionIds: lecturerClashes.map((s) => s.id),
      });
    }

    const ownSectionIds = session.sections.map((s) => s.sectionId);
    const enrolled = await this.enrollments.enrolledBySection([
      ...ownSectionIds,
      ...others.flatMap((o) => o.sections.map((s) => s.sectionId)),
    ]);
    const students = new Set(ownSectionIds.flatMap((id) => enrolled.get(id) ?? []));
    const clashing = new Set<string>();
    for (const other of others) {
      for (const s of other.sections) {
        for (const student of enrolled.get(s.sectionId) ?? [])
          if (students.has(student)) clashing.add(student);
      }
    }
    if (clashing.size > 0) {
      warnings.push({
        code: 'STUDENT_CLASH',
        message: `${clashing.size} student(s) of this class have another class at that time.`,
        students: clashing.size,
      });
    }
    if (room?.capacity && students.size > room.capacity) {
      warnings.push({
        code: 'ROOM_TOO_SMALL',
        message: `The room holds ${room.capacity}; ${students.size} students are enrolled.`,
      });
    }

    const day = dayIn(start, this.config.institutionTimezone);
    const sections = await this.courses.sectionSummaries(ownSectionIds);
    for (const semesterId of new Set([...sections.values()].map((s) => s.semester.id))) {
      const name = (await this.academic.noClassDays(semesterId, day, day)).get(day);
      if (name) {
        warnings.push({
          code: 'NO_CLASS_DAY',
          message: `${day} is marked as a day without classes: ${name}.`,
          name,
        });
        break;
      }
    }
    return { blockers, warnings };
  }

  private assertNoBlockers(found: { blockers: Finding[]; warnings: Finding[] }) {
    if (found.blockers.length === 0) return;
    throw new ConflictException({
      code: 'RESCHEDULE_BLOCKED',
      message: found.blockers.map((b) => b.message).join(' '),
      details: found,
    });
  }

  private assertReschedulable(session: ClassSession) {
    if (!RESCHEDULABLE.includes(session.status)) {
      throw new ConflictException({
        code: 'TRANSITION_NOT_ALLOWED',
        message: `A class that is ${session.status.toLowerCase().replace('_', ' ')} cannot be rescheduled.`,
      });
    }
  }

  /** The class's own lecturer (with the request permission), or an administrator who may decide. */
  private async assertMayPropose(actor: AccessClaims, session: SessionWithSections) {
    if (actor.role === 'LECTURER') {
      const held = await this.permissions.forRole(actor.role);
      const lecturerId = await this.lecturers.idForUser(actor.userId);
      if (lecturerId !== session.lecturerId) {
        throw new ForbiddenException({
          code: 'NOT_YOUR_CLASS',
          message: 'Only the lecturer of this class can do this.',
        });
      }
      if (!held.has('class_sessions.request_reschedule')) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'You do not have permission to do this.',
        });
      }
      return;
    }
    await this.assertDecider(actor, session);
  }

  private async isDecider(actor: AccessClaims) {
    return (
      ADMIN_ROLES.includes(actor.role) &&
      (await this.permissions.forRole(actor.role)).has('class_sessions.reschedule')
    );
  }

  /** An administrator with the reschedule permission whose scope covers every section of the class. */
  private async assertDecider(actor: AccessClaims, session: SessionWithSections) {
    if (!(await this.isDecider(actor))) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to do this.',
      });
    }
    const sections = await this.courses.sectionSummaries(session.sections.map((s) => s.sectionId));
    for (const s of sections.values()) await this.access.assertDepartment(actor, s.department);
  }

  private async withinScope<T extends { classSession: SessionWithSections }>(actor: AccessClaims, rows: T[]) {
    const sections = await this.courses.sectionSummaries(
      rows.flatMap((r) => r.classSession.sections.map((s) => s.sectionId)),
    );
    const kept: T[] = [];
    for (const row of rows) {
      let covered = true;
      for (const s of row.classSession.sections) {
        const info = sections.get(s.sectionId);
        if (!info || !(await this.access.covers(actor, info.department))) covered = false;
      }
      if (covered) kept.push(row);
    }
    return kept;
  }

  // ───────── Writes ─────────

  private async createReplacement(
    tx: Prisma.TransactionClient,
    actor: AccessClaims,
    original: ClassSession,
    request: RescheduleRequest,
    now: Date,
  ) {
    const sections = await tx.classSessionSection.findMany({ where: { classSessionId: original.id } });
    const replacement = await tx.classSession.create({
      data: {
        kind: 'REPLACEMENT',
        rescheduledFromId: original.id,
        lecturerId: original.lecturerId,
        classroomId: request.proposedClassroomId,
        scheduledStart: request.proposedStart,
        scheduledEnd: request.proposedEnd,
        statusChangedAt: now,
        sections: { create: sections.map((s) => ({ sectionId: s.sectionId })) },
      },
    });
    await tx.classEvent.create({
      data: {
        classSessionId: replacement.id,
        type: 'GENERATED',
        toStatus: 'SCHEDULED',
        actorType: 'USER',
        actorUserId: actor.userId,
        payload: { replaces: original.id, rescheduleRequestId: request.id },
        occurredAt: now,
      },
    });
    return replacement;
  }

  private eventDetails(requestId: string, replacement: ClassSession) {
    return {
      rescheduleRequestId: requestId,
      replacementSessionId: replacement.id,
      newStart: replacement.scheduledStart.toISOString(),
      newEnd: replacement.scheduledEnd.toISOString(),
      newClassroomId: replacement.classroomId,
    };
  }

  private async close(
    actor: AccessClaims,
    row: RescheduleRequest,
    status: 'REJECTED' | 'WITHDRAWN',
    note: string | null,
    action: string,
    context: RequestContext,
  ) {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.rescheduleRequest.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status, decidedById: actor.userId, decidedAt: now, decisionNote: note },
      });
      if (done.count !== 1) throw alreadyDecided();
      await this.audit.record(
        auditEntry(
          actor,
          action,
          { type: 'reschedule_request', id: row.id },
          { before: { status: 'PENDING' }, after: { status }, reason: note ?? undefined },
          context,
        ),
        tx,
      );
    });
  }

  /** Closes a lecturer's waiting request when an administrator reschedules the class directly. */
  private async closeWaiting(
    tx: Prisma.TransactionClient,
    actor: AccessClaims,
    sessionId: string,
    now: Date,
    context: RequestContext,
  ) {
    const waiting = await tx.rescheduleRequest.findFirst({
      where: { classSessionId: sessionId, status: 'PENDING' },
    });
    if (!waiting) return;
    const note = 'Closed: an administrator rescheduled this class directly.';
    await tx.rescheduleRequest.update({
      where: { id: waiting.id },
      data: { status: 'REJECTED', decidedById: actor.userId, decidedAt: now, decisionNote: note },
    });
    await this.audit.record(
      auditEntry(
        actor,
        'reschedule_requests.rejected',
        { type: 'reschedule_request', id: waiting.id },
        { before: { status: 'PENDING' }, after: { status: 'REJECTED' }, reason: note },
        context,
      ),
      tx,
    );
  }

  // ───────── Reading ─────────

  private times(p: Proposal) {
    const tz = this.config.institutionTimezone;
    return {
      start: wallClockToUtc(p.date, toMinutes(p.startTime), tz),
      end: wallClockToUtc(p.date, toMinutes(p.endTime), tz),
    };
  }

  private async session(id: string): Promise<SessionWithSections> {
    const row = await this.prisma.classSession.findUnique({ where: { id }, include: { sections: true } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such class session.' });
    return row;
  }

  private async findRequest(id: string) {
    const row = await this.prisma.rescheduleRequest.findUnique({ where: { id } });
    if (!row) throw notFound();
    return row;
  }

  private auditView(row: RescheduleRequest) {
    return {
      classSessionId: row.classSessionId,
      proposedStart: row.proposedStart.toISOString(),
      proposedEnd: row.proposedEnd.toISOString(),
      proposedClassroomId: row.proposedClassroomId,
      isDirect: row.isDirect,
    };
  }

  private async view(row: RescheduleRequest) {
    return (await this.views([row]))[0]!;
  }

  private async views(rows: RescheduleRequest[]) {
    const [sessions, rooms] = await Promise.all([
      this.sessions.summaries(
        rows.flatMap((r) => [r.classSessionId, ...(r.replacementSessionId ? [r.replacementSessionId] : [])]),
      ),
      this.places.classroomFacts(rows.map((r) => r.proposedClassroomId)),
    ]);
    return rows.map((r) => {
      const room = rooms.get(r.proposedClassroomId);
      return {
        id: r.id,
        status: r.status,
        isDirect: r.isDirect,
        reason: r.reason,
        proposedStart: r.proposedStart,
        proposedEnd: r.proposedEnd,
        proposedClassroom: room ? { id: room.id, code: room.code, name: room.name } : null,
        classSession: sessions.get(r.classSessionId) ?? null,
        replacementSession: r.replacementSessionId ? (sessions.get(r.replacementSessionId) ?? null) : null,
        requestedById: r.requestedById,
        decidedById: r.decidedById,
        decidedAt: r.decidedAt,
        decisionNote: r.decisionNote,
        createdAt: r.createdAt,
      };
    });
  }
}
