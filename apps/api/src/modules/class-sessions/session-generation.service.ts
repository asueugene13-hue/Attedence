import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { dayIn, wallClockToUtc } from '../../common/time-zone.js';
import { AppConfig } from '../../config/app-config.js';
import type { ClassStatus, Prisma } from '../../generated/prisma/client.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import { TimetablesService } from '../timetables/timetables.service.js';
import { writeClassEvent } from './class-event-log.js';

/** Statuses of a class that has not started yet: the only sessions a timetable change may alter. */
export const NOT_STARTED: ClassStatus[] = [
  'SCHEDULED',
  'CONFIRMED',
  'POSTPONED',
  'UNCONFIRMED',
  'UNDER_REVIEW',
  'SUSPENDED',
];

export interface GenerationSummary {
  created: number;
  updated: number;
  carriedOver: number;
  cancelled: number;
  /** Classes a timetable or calendar change had cancelled, brought back because the change was undone. */
  reinstated: number;
  /** Such classes left cancelled because their room or lecturer has since been booked. */
  notReinstated: number;
  unchanged: number;
}

type Planned = NonNullable<Awaited<ReturnType<TimetablesService['plannedMeetings']>>>['entries'][number];

/**
 * Turns a published timetable into concrete class sessions (CLASS_LIFECYCLE.md §2). Runs as a
 * background job queued with the publish, and is safe to run again: it reconciles instead of adding.
 *
 * - Every future meeting gets a session; a re-run never duplicates one.
 * - When a new version replaces an old one, future sessions of unchanged entries carry over (so
 *   confirmations and history stay); changed ones are updated; meetings that disappeared are cancelled
 *   with reason OTHER and the note "Timetable changed", recorded as the publishing administrator's act.
 * - A meeting removed by a holiday is cancelled as PUBLIC_HOLIDAY or INSTITUTION_EVENT, "No classes: <name>".
 * - A class cancelled by such a change (never one a person cancelled) comes back if the change is
 *   undone, unless its room or lecturer has been booked meanwhile.
 * - A session that has started, or lies in the past, is never touched.
 * - The database refuses any room or lecturer double-booking when the transaction commits.
 */
@Injectable()
export class SessionGenerationService implements OnModuleInit {
  private readonly logger = new Logger(SessionGenerationService.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobRegistry,
    private readonly timetables: TimetablesService,
    private readonly academic: AcademicLookupsService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.jobs.define<{ timetableId: string; publishedById: string }>({
      queue: 'system',
      name: 'generate-sessions',
      attempts: 5,
      handle: async (data) => {
        await this.generate(data.timetableId, data.publishedById);
      },
    });
    // Queued by the academic module when a holiday or closure is added or removed.
    this.jobs.define<{ semesterId: string | null; from: string; to: string; changedById: string }>({
      queue: 'system',
      name: 'calendar-changed',
      attempts: 5,
      handle: async (data) => {
        const semesterIds = await this.academic.semesterIdsOverlapping(data.from, data.to, data.semesterId);
        for (const timetableId of await this.timetables.publishedTimetableIds(semesterIds)) {
          await this.generate(timetableId, data.changedById);
        }
      },
    });
  }

  async generate(timetableId: string, publishedById: string): Promise<GenerationSummary | null> {
    const plan = await this.timetables.plannedMeetings(timetableId);
    // A version replaced before its job ran is skipped: the newer version's job does the work.
    if (!plan || plan.status !== 'PUBLISHED') return null;
    const timeZone = this.config.institutionTimezone;
    const now = this.clock.now();
    const sourceEntryIds = [
      ...(await this.timetables.entryIdsOf(timetableId)),
      ...(plan.previousTimetableId ? await this.timetables.entryIdsOf(plan.previousTimetableId) : []),
    ];
    const desired = plan.entries.flatMap((entry) =>
      entry.dates
        .map((day) => ({
          entry,
          start: wallClockToUtc(day, entry.startMinute, timeZone),
          end: wallClockToUtc(day, entry.endMinute, timeZone),
        }))
        .filter((d) => d.start > now),
    );

    const summary: GenerationSummary = {
      created: 0,
      updated: 0,
      carriedOver: 0,
      cancelled: 0,
      reinstated: 0,
      notReinstated: 0,
      unchanged: 0,
    };
    // Why a meeting of an entry (or of the entry it was copied from) no longer takes place.
    const skipFor = (entryId: string | null, start: Date) => {
      const day = dayIn(start, timeZone);
      const entry = plan.entries.find((e) => e.entryId === entryId || e.sourceEntryId === entryId);
      return entry?.skipped.get(day) ?? { reason: 'OTHER' as const, note: 'Timetable changed' };
    };
    await this.prisma.$transaction(
      async (tx) => {
        // One generation per semester at a time; overlap rules are checked once, at commit.
        // $executeRaw, because the lock function returns nothing Prisma can read back.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${plan.semesterId}))`;
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "class_sessions_room_no_overlap", "class_sessions_lecturer_no_overlap" DEFERRED',
        );
        const existing = await tx.classSession.findMany({
          where: { timetableEntryId: { in: sourceEntryIds }, scheduledStart: { gt: now } },
          include: { sections: { select: { sectionId: true } } },
        });
        const byKey = new Map(
          existing.map((s) => [`${s.timetableEntryId}|${s.scheduledStart.toISOString()}`, s]),
        );
        const matched = new Set<string>();

        for (const d of desired) {
          const own = byKey.get(`${d.entry.entryId}|${d.start.toISOString()}`);
          const carried =
            !own && d.entry.sourceEntryId
              ? byKey.get(`${d.entry.sourceEntryId}|${d.start.toISOString()}`)
              : undefined;
          const session = own ?? carried;
          if (session && !matched.has(session.id)) {
            matched.add(session.id);
            if (carried) summary.carriedOver += 1;
            if (session.status === 'CANCELLED') {
              await this.reinstateIfFree(tx, session, d, publishedById, timetableId, now, summary);
              continue;
            }
            await this.reconcile(tx, session, d, Boolean(carried), publishedById, timetableId, summary);
            continue;
          }
          await this.create(tx, d, timetableId);
          summary.created += 1;
        }

        for (const s of existing) {
          if (matched.has(s.id) || !NOT_STARTED.includes(s.status)) continue;
          const why = skipFor(s.timetableEntryId, s.scheduledStart);
          await tx.classSession.update({
            where: { id: s.id },
            data: {
              status: 'CANCELLED',
              cancelReason: why.reason,
              cancelNote: why.note,
              cancelledById: publishedById,
              cancelledByTimetableChange: true,
              statusChangedAt: now,
              version: { increment: 1 },
            },
          });
          await writeClassEvent(tx, this.outbox, {
            data: {
              classSessionId: s.id,
              type: 'CANCELLED',
              fromStatus: s.status,
              toStatus: 'CANCELLED',
              actorType: 'USER',
              actorUserId: publishedById,
              payload: { reason: why.reason, note: why.note, timetableId },
            },
          });
          summary.cancelled += 1;
        }
      },
      { timeout: 5 * 60_000, maxWait: 30_000 },
    );
    await this.timetables.markSessionsGenerated(timetableId, this.clock.now());
    this.logger.log(`Sessions for timetable ${timetableId}: ${JSON.stringify(summary)}`);
    return summary;
  }

  private async create(
    tx: Prisma.TransactionClient,
    d: { entry: Planned; start: Date; end: Date },
    timetableId: string,
  ) {
    const session = await tx.classSession.create({
      data: {
        timetableEntryId: d.entry.entryId,
        lecturerId: d.entry.lecturerId,
        classroomId: d.entry.classroomId,
        scheduledStart: d.start,
        scheduledEnd: d.end,
        sections: { create: d.entry.sectionIds.map((sectionId) => ({ sectionId })) },
      },
    });
    await writeClassEvent(tx, this.outbox, {
      data: {
        classSessionId: session.id,
        type: 'GENERATED',
        toStatus: 'SCHEDULED',
        actorType: 'SYSTEM',
        payload: { timetableId },
      },
    });
  }

  /**
   * A cancelled session whose meeting is back. Only a class that a timetable or calendar change
   * cancelled returns, and only if its room and lecturer are still free; a class a person cancelled
   * stays cancelled (it is only re-pointed to the new version's entry).
   */
  private async reinstateIfFree(
    tx: Prisma.TransactionClient,
    session: Prisma.ClassSessionGetPayload<{ include: { sections: { select: { sectionId: true } } } }>,
    d: { entry: Planned; end: Date },
    actorId: string,
    timetableId: string,
    now: Date,
    summary: GenerationSummary,
  ) {
    const repoint = { timetableEntryId: d.entry.entryId };
    if (!session.cancelledByTimetableChange || session.actualStart) {
      await tx.classSession.update({ where: { id: session.id }, data: repoint });
      summary.unchanged += 1;
      return;
    }
    const taken = await tx.classSession.count({
      where: {
        id: { not: session.id },
        status: { notIn: ['CANCELLED', 'RESCHEDULED'] },
        scheduledStart: { lt: d.end },
        scheduledEnd: { gt: session.scheduledStart },
        OR: [{ classroomId: d.entry.classroomId }, { lecturerId: d.entry.lecturerId }],
      },
    });
    if (taken > 0) {
      await tx.classSession.update({ where: { id: session.id }, data: repoint });
      summary.notReinstated += 1;
      return;
    }
    await tx.classSession.update({
      where: { id: session.id },
      data: {
        ...repoint,
        status: 'SCHEDULED',
        lecturerId: d.entry.lecturerId,
        classroomId: d.entry.classroomId,
        scheduledEnd: d.end,
        cancelReason: null,
        cancelNote: null,
        cancelledById: null,
        cancelledByTimetableChange: false,
        expectedStart: null,
        statusChangedAt: now,
        version: { increment: 1 },
      },
    });
    const sectionIds = [...d.entry.sectionIds].sort();
    if (
      session.sections
        .map((x) => x.sectionId)
        .sort()
        .join() !== sectionIds.join()
    ) {
      await tx.classSessionSection.deleteMany({ where: { classSessionId: session.id } });
      await tx.classSessionSection.createMany({
        data: sectionIds.map((sectionId) => ({ classSessionId: session.id, sectionId })),
      });
    }
    await writeClassEvent(tx, this.outbox, {
      data: {
        classSessionId: session.id,
        type: 'REINSTATED',
        fromStatus: 'CANCELLED',
        toStatus: 'SCHEDULED',
        actorType: 'USER',
        actorUserId: actorId,
        payload: {
          note: 'The timetable or calendar change that cancelled this class was undone',
          timetableId,
        },
        occurredAt: now,
      },
    });
    summary.reinstated += 1;
  }

  /**
   * Brings an existing future session in line with its entry. A session that has not started gets the
   * entry's lecturer, room, end time and sections; one already cancelled or rescheduled keeps its
   * status. Either way a carried-over session is re-pointed to the new version's entry.
   */
  private async reconcile(
    tx: Prisma.TransactionClient,
    session: Prisma.ClassSessionGetPayload<{ include: { sections: { select: { sectionId: true } } } }>,
    d: { entry: Planned; end: Date },
    carried: boolean,
    publishedById: string,
    timetableId: string,
    summary: GenerationSummary,
  ) {
    const before = {
      lecturerId: session.lecturerId,
      classroomId: session.classroomId,
      scheduledEnd: session.scheduledEnd.toISOString(),
      sectionIds: session.sections.map((s) => s.sectionId).sort(),
    };
    const after = {
      lecturerId: d.entry.lecturerId,
      classroomId: d.entry.classroomId,
      scheduledEnd: d.end.toISOString(),
      sectionIds: [...d.entry.sectionIds].sort(),
    };
    const changed = NOT_STARTED.includes(session.status) && JSON.stringify(before) !== JSON.stringify(after);
    if (!changed && !carried) {
      summary.unchanged += 1;
      return;
    }
    await tx.classSession.update({
      where: { id: session.id },
      data: {
        timetableEntryId: d.entry.entryId,
        ...(changed
          ? {
              lecturerId: d.entry.lecturerId,
              classroomId: d.entry.classroomId,
              scheduledEnd: d.end,
              version: { increment: 1 },
            }
          : {}),
      },
    });
    if (changed) {
      if (before.sectionIds.join() !== after.sectionIds.join()) {
        await tx.classSessionSection.deleteMany({ where: { classSessionId: session.id } });
        await tx.classSessionSection.createMany({
          data: after.sectionIds.map((sectionId) => ({ classSessionId: session.id, sectionId })),
        });
      }
      const onlyRoom =
        before.classroomId !== after.classroomId &&
        before.lecturerId === after.lecturerId &&
        before.scheduledEnd === after.scheduledEnd &&
        before.sectionIds.join() === after.sectionIds.join();
      await writeClassEvent(tx, this.outbox, {
        data: {
          classSessionId: session.id,
          type: onlyRoom ? 'VENUE_CHANGED' : 'UPDATED',
          fromStatus: session.status,
          toStatus: session.status,
          actorType: 'USER',
          actorUserId: publishedById,
          payload: { before, after, timetableId },
        },
      });
      summary.updated += 1;
    } else {
      summary.unchanged += 1;
    }
  }
}
