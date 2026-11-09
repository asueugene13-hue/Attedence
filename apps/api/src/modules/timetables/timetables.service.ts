import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { toHhmm, toMinutes, type TimetableEntryInput, type TimetableQuerySchema } from '@attendsure/shared';
import type { z } from 'zod';
import { auditEntry } from '../../common/audit-entry.js';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { PlacesService } from '../places/places.service.js';
import { StudentsService } from '../students/students.service.js';
import { blockingClashes, type ExpandedEntry, overlappingPairs, studentClashes } from './conflicts.js';
import { meetingDates, ruleDates, weekdayOf, weeksInSemester } from './recurrence.js';

type Tx = Prisma.TransactionClient;

const notFound = (what = 'timetable') =>
  new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });
const invalid = (code: string, message: string) => new BadRequestException({ code, message });
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const toDay = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

const entryInclude = {
  sections: { select: { sectionId: true } },
  exceptions: { orderBy: { date: 'asc' } },
} satisfies Prisma.TimetableEntryInclude;
type EntryRow = Prisma.TimetableEntryGetPayload<{ include: typeof entryInclude }>;

/**
 * Timetables (CLASS_LIFECYCLE.md §1). A semester has at most one draft and one published timetable.
 * Entries are edited in the draft; publishing runs the clash check and is refused while a room, a
 * lecturer or a section is booked twice at the same time. Student clashes and other concerns are
 * warnings. Editing after publishing arrives with the class lifecycle (Phase 3 step 4).
 */
@Injectable()
export class TimetablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
    private readonly academic: AcademicLookupsService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly places: PlacesService,
    private readonly enrollments: EnrollmentsService,
    private readonly students: StudentsService,
    private readonly outbox: OutboxService,
  ) {}

  // ───────── Timetables ─────────

  list(query: z.output<typeof TimetableQuerySchema>) {
    return this.prisma.timetable.findMany({
      where: {
        ...(query.semesterId ? { semesterId: query.semesterId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ semesterId: 'asc' }, { version: 'desc' }],
      include: { _count: { select: { entries: { where: { isCancelled: false } } } } },
    });
  }

  async get(id: string) {
    const timetable = await this.prisma.timetable.findUnique({
      where: { id },
      include: {
        entries: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }], include: entryInclude },
      },
    });
    if (!timetable) throw notFound();
    const semester = await this.academic.semester(timetable.semesterId);
    const { entries, ...rest } = timetable;
    return { ...rest, semester, entries: await this.entryViews(entries) };
  }

  /**
   * A new draft for a semester. When the semester already has a published timetable, the draft starts
   * as a copy of it, so a new version is an edit of the current one rather than a blank page.
   */
  async create(actor: AccessClaims, input: { semesterId: string; name: string }, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    const semester = await this.academic.semester(input.semesterId);
    if (!semester) throw invalid('INVALID_SEMESTER', 'No such semester.');
    if (semester.status === 'CLOSED') throw conflict('SEMESTER_CLOSED', 'That semester is closed.');
    const created = await this.prisma
      .$transaction(async (tx) => {
        const latest = await tx.timetable.findFirst({
          where: { semesterId: input.semesterId },
          orderBy: { version: 'desc' },
        });
        const timetable = await tx.timetable.create({
          data: {
            semesterId: input.semesterId,
            name: input.name,
            version: (latest?.version ?? 0) + 1,
            createdById: actor.userId,
          },
        });
        const published = await tx.timetable.findFirst({
          where: { semesterId: input.semesterId, status: 'PUBLISHED' },
          include: { entries: { where: { isCancelled: false }, include: entryInclude } },
        });
        for (const e of published?.entries ?? []) {
          await tx.timetableEntry.create({
            data: {
              timetableId: timetable.id,
              lecturerId: e.lecturerId,
              classroomId: e.classroomId,
              dayOfWeek: e.dayOfWeek,
              startMinute: e.startMinute,
              endMinute: e.endMinute,
              recurrence: e.recurrence,
              selectedWeeks: e.selectedWeeks,
              effectiveFrom: e.effectiveFrom,
              effectiveTo: e.effectiveTo,
              // Remembered so this version's sessions can take over the previous version's.
              sourceEntryId: e.id,
              createdById: actor.userId,
              sections: { create: e.sections.map((s) => ({ sectionId: s.sectionId })) },
              exceptions: {
                create: e.exceptions.map((x) => ({
                  date: x.date,
                  reason: x.reason,
                  createdById: x.createdById,
                })),
              },
            },
          });
        }
        await this.change(tx, timetable.id, null, 'CREATED', actor, null, {
          name: timetable.name,
          version: timetable.version,
          copiedFromVersion: published?.version ?? null,
        });
        await this.audit.record(
          auditEntry(
            actor,
            'timetables.created',
            { type: 'timetable', id: timetable.id },
            { after: timetable },
            context,
          ),
          tx,
        );
        return timetable;
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          timetables_one_draft: {
            code: 'DRAFT_EXISTS',
            message: 'This semester already has a draft timetable. Edit that one.',
          },
        }),
      );
    return this.get(created.id);
  }

  // ───────── Entries ─────────

  async addEntry(
    actor: AccessClaims,
    timetableId: string,
    input: TimetableEntryInput,
    context: RequestContext,
  ) {
    const timetable = await this.draft(timetableId);
    const data = await this.resolveEntry(actor, timetable.semesterId, input);
    const entry = await this.prisma.$transaction(async (tx) => {
      const created = await tx.timetableEntry.create({
        data: {
          ...data.columns,
          timetableId,
          createdById: actor.userId,
          sections: { create: data.sectionIds.map((sectionId) => ({ sectionId })) },
        },
      });
      await this.change(tx, timetableId, created.id, 'ENTRY_ADDED', actor, null, { ...data.summary });
      await this.audit.record(
        auditEntry(
          actor,
          'timetables.entry_added',
          { type: 'timetable_entry', id: created.id },
          { after: data.summary },
          context,
        ),
        tx,
      );
      return created;
    });
    return this.entryView(entry.id);
  }

  /** Replaces an entry's details. Version-checked, like every other edit. */
  async updateEntry(
    actor: AccessClaims,
    entryId: string,
    expectedVersion: number,
    input: TimetableEntryInput,
    context: RequestContext,
  ) {
    const before = await this.findEntry(entryId);
    const timetable = await this.draft(before.timetableId);
    await this.assertEntryScope(actor, before);
    const data = await this.resolveEntry(actor, timetable.semesterId, input);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.timetableEntry.updateMany({
        where: { id: entryId, version: expectedVersion, isCancelled: false },
        data: { ...data.columns, version: { increment: 1 } },
      });
      if (claimed.count !== 1) throw versionConflict(before.version);
      await tx.timetableEntrySection.deleteMany({ where: { entryId } });
      await tx.timetableEntrySection.createMany({
        data: data.sectionIds.map((sectionId) => ({ entryId, sectionId })),
      });
      const beforeSummary = this.columnsSummary(before);
      await this.change(tx, before.timetableId, entryId, 'ENTRY_UPDATED', actor, beforeSummary, data.summary);
      await this.audit.record(
        auditEntry(
          actor,
          'timetables.entry_updated',
          { type: 'timetable_entry', id: entryId },
          { before: beforeSummary, after: data.summary },
          context,
        ),
        tx,
      );
    });
    return this.entryView(entryId);
  }

  /** Removes an entry from the draft. It is kept, marked cancelled, with the reason in the history. */
  async cancelEntry(actor: AccessClaims, entryId: string, reason: string, context: RequestContext) {
    const entry = await this.findEntry(entryId);
    await this.draft(entry.timetableId);
    await this.assertEntryScope(actor, entry);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.timetableEntry.updateMany({
        where: { id: entryId, isCancelled: false },
        data: { isCancelled: true, version: { increment: 1 } },
      });
      if (claimed.count !== 1) throw conflict('ALREADY_CANCELLED', 'This entry is already cancelled.');
      await this.change(
        tx,
        entry.timetableId,
        entryId,
        'ENTRY_CANCELLED',
        actor,
        this.columnsSummary(entry),
        null,
        reason,
      );
      await this.audit.record(
        auditEntry(
          actor,
          'timetables.entry_cancelled',
          { type: 'timetable_entry', id: entryId },
          { reason },
          context,
        ),
        tx,
      );
    });
    return this.entryView(entryId);
  }

  /** One date this entry does not meet (for example the lecturer is away), with a reason. */
  async addException(
    actor: AccessClaims,
    entryId: string,
    input: { date: string; reason: string },
    context: RequestContext,
  ) {
    const entry = await this.findEntry(entryId);
    const timetable = await this.draft(entry.timetableId);
    await this.assertEntryScope(actor, entry);
    const semester = (await this.academic.semester(timetable.semesterId))!;
    if (!ruleDates(this.ruleOf(entry), semester.startDate).includes(input.date)) {
      throw invalid('NOT_A_MEETING_DATE', 'This entry does not meet on that date.');
    }
    await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.timetableEntryException.create({
          data: { entryId, date: asDate(input.date), reason: input.reason, createdById: actor.userId },
        });
        await this.change(
          tx,
          entry.timetableId,
          entryId,
          'EXCEPTION_ADDED',
          actor,
          null,
          { date: input.date },
          input.reason,
        );
        await this.audit.record(
          auditEntry(
            actor,
            'timetables.exception_added',
            { type: 'timetable_entry', id: entryId },
            { after: { exceptionId: created.id, date: input.date }, reason: input.reason },
            context,
          ),
          tx,
        );
      })
      .catch((e: unknown) =>
        rethrowAsConflict(e, {
          unique: { code: 'ALREADY_EXCEPTED', message: 'That date is already skipped for this entry.' },
        }),
      );
    return this.entryView(entryId);
  }

  async removeException(
    actor: AccessClaims,
    entryId: string,
    exceptionId: string,
    reason: string,
    context: RequestContext,
  ) {
    const entry = await this.findEntry(entryId);
    await this.draft(entry.timetableId);
    await this.assertEntryScope(actor, entry);
    const exception = entry.exceptions.find((x) => x.id === exceptionId);
    if (!exception) throw notFound('exception');
    await this.prisma.$transaction(async (tx) => {
      await tx.timetableEntryException.delete({ where: { id: exceptionId } });
      await this.change(
        tx,
        entry.timetableId,
        entryId,
        'EXCEPTION_REMOVED',
        actor,
        { date: toDay(exception.date), reason: exception.reason },
        null,
        reason,
      );
      await this.audit.record(
        auditEntry(
          actor,
          'timetables.exception_removed',
          { type: 'timetable_entry', id: entryId },
          { before: { date: toDay(exception.date) }, reason },
          context,
        ),
        tx,
      );
    });
    return this.entryView(entryId);
  }

  /** The dates an entry will meet on, and the dates skipped (holidays, exceptions) with why. */
  async entryDates(entryId: string) {
    const entry = await this.findEntry(entryId);
    const timetable = await this.prisma.timetable.findUniqueOrThrow({ where: { id: entry.timetableId } });
    const semester = (await this.academic.semester(timetable.semesterId))!;
    const noClassDays = await this.academic.noClassDays(semester.id, semester.startDate, semester.endDate);
    return meetingDates(this.ruleOf(entry), semester.startDate, noClassDays, exceptionsOf(entry));
  }

  // ───────── Clash check and publishing ─────────

  /** Blocking clashes (room, lecturer, section) and warnings, for the draft or any version. */
  async conflicts(timetableId: string) {
    const timetable = await this.prisma.timetable.findUnique({
      where: { id: timetableId },
      include: { entries: { where: { isCancelled: false }, include: entryInclude } },
    });
    if (!timetable) throw notFound();
    const semester = (await this.academic.semester(timetable.semesterId))!;
    const noClassDays = await this.academic.noClassDays(semester.id, semester.startDate, semester.endDate);
    const expanded: (ExpandedEntry & { skipped: { date: string; why: string }[] })[] = timetable.entries.map(
      (e) => {
        const { dates, skipped } = meetingDates(
          this.ruleOf(e),
          semester.startDate,
          noClassDays,
          exceptionsOf(e),
        );
        return {
          id: e.id,
          classroomId: e.classroomId,
          lecturerId: e.lecturerId,
          sectionIds: e.sections.map((s) => s.sectionId),
          startMinute: e.startMinute,
          endMinute: e.endMinute,
          dates,
          skipped,
        };
      },
    );
    const pairs = overlappingPairs(expanded);
    const enrolled = await this.enrollments.enrolledBySection(expanded.flatMap((e) => e.sectionIds));
    const views = new Map((await this.entryViews(timetable.entries)).map((v) => [v.id, v]));
    const label = (id: string) => views.get(id)!.label;

    const blocking = blockingClashes(expanded, pairs).map((c) => ({
      ...c,
      message: `${CLASH_TEXT[c.kind]}: ${label(c.entryIds[0])} and ${label(c.entryIds[1])} (from ${c.firstDate}, ${c.dates} date${c.dates === 1 ? '' : 's'})`,
    }));

    const warnings: { kind: string; entryIds: string[]; message: string; studentNumbers?: string[] }[] = [];
    const clashes = studentClashes(expanded, pairs, enrolled);
    const studentInfo = await this.students.summaries(clashes.flatMap((c) => c.studentIds));
    for (const c of clashes) {
      warnings.push({
        kind: 'STUDENT_CLASH',
        entryIds: c.entryIds,
        studentNumbers: c.studentIds.slice(0, 20).map((s) => studentInfo.get(s)?.studentNumber ?? s),
        message: `${c.studentIds.length} student${c.studentIds.length === 1 ? ' is' : 's are'} enrolled in both ${label(c.entryIds[0])} and ${label(c.entryIds[1])}`,
      });
    }
    const rooms = await this.places.classroomFacts(expanded.map((e) => e.classroomId));
    const lecturerFacts = await this.lecturers.facts(expanded.map((e) => e.lecturerId));
    for (const e of expanded) {
      const students = new Set(e.sectionIds.flatMap((s) => enrolled.get(s) ?? []));
      const room = rooms.get(e.classroomId);
      if (room?.capacity && students.size > room.capacity) {
        warnings.push({
          kind: 'ROOM_TOO_SMALL',
          entryIds: [e.id],
          message: `${label(e.id)}: ${students.size} students enrolled, room ${room.code} seats ${room.capacity}`,
        });
      }
      if (room && !room.isActive) {
        warnings.push({
          kind: 'ROOM_INACTIVE',
          entryIds: [e.id],
          message: `${label(e.id)}: room ${room.code} is no longer active`,
        });
      }
      if (lecturerFacts.get(e.lecturerId)?.status === 'ON_LEAVE') {
        warnings.push({
          kind: 'LECTURER_ON_LEAVE',
          entryIds: [e.id],
          message: `${label(e.id)}: the lecturer is marked on leave`,
        });
      }
      if (e.skipped.length > 0) {
        warnings.push({
          kind: 'DATES_SKIPPED',
          entryIds: [e.id],
          message: `${label(e.id)}: no class on ${e.skipped.map((s) => `${s.date} (${s.why})`).join(', ')}`,
        });
      }
      if (e.dates.length === 0) {
        warnings.push({
          kind: 'NO_MEETINGS',
          entryIds: [e.id],
          message: `${label(e.id)}: every date is skipped, so this entry never meets`,
        });
      }
    }
    return { timetableId, blocking, warnings, canPublish: blocking.length === 0 };
  }

  /** Publishes the draft, replacing the semester's published timetable. Refused while clashes remain. */
  async publish(actor: AccessClaims, id: string, reason: string | undefined, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    const timetable = await this.draft(id);
    const check = await this.conflicts(id);
    if (!check.canPublish) {
      throw new ConflictException({
        code: 'HAS_CONFLICTS',
        message: `Publishing is blocked by ${check.blocking.length} clash${check.blocking.length === 1 ? '' : 'es'}. Fix them and try again.`,
        errors: check.blocking.map((b) => ({ field: null, message: b.message })),
      });
    }
    const active = await this.prisma.timetableEntry.count({ where: { timetableId: id, isCancelled: false } });
    if (active === 0)
      throw conflict('EMPTY_TIMETABLE', 'A timetable needs at least one entry before it is published.');
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.timetable.findFirst({
        where: { semesterId: timetable.semesterId, status: 'PUBLISHED' },
      });
      if (previous) {
        await tx.timetable.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED' } });
        await this.change(tx, previous.id, null, 'SUPERSEDED', actor, null, { byVersion: timetable.version });
      }
      const claimed = await tx.timetable.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: actor.userId },
      });
      if (claimed.count !== 1) throw conflict('NOT_DRAFT', 'This timetable is no longer a draft.');
      await this.change(
        tx,
        id,
        null,
        'PUBLISHED',
        actor,
        null,
        { entries: active, warnings: check.warnings.length },
        reason,
      );
      await this.audit.record(
        auditEntry(
          actor,
          'timetables.published',
          { type: 'timetable', id },
          {
            after: { version: timetable.version, entries: active, supersededId: previous?.id ?? null },
            reason,
          },
          context,
        ),
        tx,
      );
      // The class meetings are generated in the background, queued with the publish itself.
      await this.outbox.add(tx, 'system', 'generate-sessions', {
        timetableId: id,
        publishedById: actor.userId,
      });
    });
    return this.get(id);
  }

  /**
   * Everything session generation needs for a timetable: each active entry with its meeting dates
   * (holidays and exceptions already removed) and the entry it was copied from, so future sessions
   * carry over between versions. Used by the class-sessions module.
   */
  async plannedMeetings(timetableId: string) {
    const timetable = await this.prisma.timetable.findUnique({
      where: { id: timetableId },
      include: { entries: { include: entryInclude } },
    });
    if (!timetable) return null;
    const semester = (await this.academic.semester(timetable.semesterId))!;
    const closures = await this.academic.closureDays(semester.id, semester.startDate, semester.endDate);
    const noClassDays = new Map([...closures].map(([day, c]) => [day, c.name]));
    // Why a meeting date is skipped, so a class it removes is cancelled with the right reason.
    const skipReason = (date: string, entryExceptions: Map<string, string>) => {
      const own = entryExceptions.get(date);
      if (own) return { reason: 'OTHER' as const, note: `Timetable changed: ${own}` };
      const closure = closures.get(date)!;
      return {
        reason:
          closure.type === 'PUBLIC_HOLIDAY' ? ('PUBLIC_HOLIDAY' as const) : ('INSTITUTION_EVENT' as const),
        note: `No classes: ${closure.name}`,
      };
    };
    const previous = await this.prisma.timetable.findFirst({
      where: { semesterId: timetable.semesterId, version: { lt: timetable.version } },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    return {
      id: timetable.id,
      status: timetable.status,
      semesterId: timetable.semesterId,
      version: timetable.version,
      previousTimetableId: previous?.id ?? null,
      entries: timetable.entries
        .filter((e) => !e.isCancelled)
        .map((e) => ({
          entryId: e.id,
          sourceEntryId: e.sourceEntryId,
          lecturerId: e.lecturerId,
          classroomId: e.classroomId,
          sectionIds: e.sections.map((s) => s.sectionId),
          startMinute: e.startMinute,
          endMinute: e.endMinute,
          ...this.meetingsWithReasons(e, semester.startDate, noClassDays, skipReason),
        })),
    };
  }

  private meetingsWithReasons(
    e: EntryRow,
    semesterStart: string,
    noClassDays: Map<string, string>,
    skipReason: (
      date: string,
      own: Map<string, string>,
    ) => { reason: 'OTHER' | 'PUBLIC_HOLIDAY' | 'INSTITUTION_EVENT'; note: string },
  ) {
    const own = exceptionsOf(e);
    const { dates, skipped } = meetingDates(this.ruleOf(e), semesterStart, noClassDays, own);
    return { dates, skipped: new Map(skipped.map((x) => [x.date, skipReason(x.date, own)])) };
  }

  /** The published timetable of each of these semesters. */
  async publishedTimetableIds(semesterIds: string[]): Promise<string[]> {
    const rows = await this.prisma.timetable.findMany({
      where: { semesterId: { in: semesterIds }, status: 'PUBLISHED' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Entry ids of a timetable (all, including cancelled), for finding sessions to reconcile. */
  async entryIdsOf(timetableId: string): Promise<string[]> {
    const rows = await this.prisma.timetableEntry.findMany({ where: { timetableId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async markSessionsGenerated(timetableId: string, at: Date): Promise<void> {
    await this.prisma.timetable.update({ where: { id: timetableId }, data: { sessionsGeneratedAt: at } });
  }

  async history(id: string) {
    await this.prisma.timetable.findUniqueOrThrow({ where: { id } }).catch(() => {
      throw notFound();
    });
    return this.prisma.timetableChange.findMany({
      where: { timetableId: id },
      orderBy: { changedAt: 'desc' },
      include: { changedBy: { select: { id: true, fullName: true } } },
    });
  }

  // ───────── Helpers ─────────

  /**
   * Checks an entry against the records it names, and turns it into columns. Every section must belong
   * to this semester's open offerings and to the administrator's scope; the lecturer must teach every
   * section; the room must be active; the dates must sit inside the semester and give at least one meeting.
   */
  private async resolveEntry(actor: AccessClaims, semesterId: string, input: TimetableEntryInput) {
    const semester = (await this.academic.semester(semesterId))!;
    const sectionIds = [...new Set(input.sectionIds)];
    const sections = await this.courses.sectionSummaries(sectionIds);
    for (const id of sectionIds) {
      const s = sections.get(id);
      if (!s || !s.isActive)
        throw invalid('INVALID_SECTION', 'One of the sections does not exist or is inactive.');
      if (s.semester.id !== semesterId)
        throw invalid('INVALID_SECTION', `Section ${s.course.code} ${s.code} belongs to another semester.`);
      if (s.offeringStatus === 'CLOSED')
        throw invalid('INVALID_SECTION', `${s.course.code} is closed for this semester.`);
      await this.access.assertDepartment(actor, s.department);
    }
    const lecturer = (await this.lecturers.facts([input.lecturerId])).get(input.lecturerId);
    if (!lecturer || lecturer.status === 'INACTIVE')
      throw invalid('INVALID_LECTURER', 'No such active lecturer.');
    const notTaught = sectionIds.filter((id) => !lecturer.sectionIds.has(id));
    if (notTaught.length > 0) {
      const names = notTaught
        .map((id) => `${sections.get(id)!.course.code} ${sections.get(id)!.code}`)
        .join(', ');
      throw invalid(
        'LECTURER_NOT_ASSIGNED',
        `${lecturer.fullName} is not assigned to ${names}. Assign them on the section first.`,
      );
    }
    const room = (await this.places.classroomFacts([input.classroomId])).get(input.classroomId);
    if (!room?.isActive) throw invalid('INVALID_CLASSROOM', 'No such active classroom.');

    const once = input.recurrence === 'ONCE';
    const effectiveFrom = once ? input.date! : (input.effectiveFrom ?? semester.startDate);
    const effectiveTo = once ? input.date! : (input.effectiveTo ?? semester.endDate);
    if (effectiveFrom < semester.startDate || effectiveTo > semester.endDate) {
      throw invalid(
        'OUTSIDE_SEMESTER',
        `Dates must fall within the semester (${semester.startDate} to ${semester.endDate}).`,
      );
    }
    const weeks = weeksInSemester(semester.startDate, semester.endDate);
    const selectedWeeks = [...new Set(input.selectedWeeks ?? [])].sort((a, b) => a - b);
    if (selectedWeeks.some((w) => w > weeks))
      throw invalid('INVALID_WEEK', `This semester has ${weeks} teaching weeks.`);
    const columns = {
      lecturerId: input.lecturerId,
      classroomId: input.classroomId,
      dayOfWeek: once ? weekdayOf(input.date!) : input.dayOfWeek!,
      startMinute: toMinutes(input.startTime),
      endMinute: toMinutes(input.endTime),
      recurrence: input.recurrence,
      selectedWeeks,
      effectiveFrom: asDate(effectiveFrom),
      effectiveTo: asDate(effectiveTo),
    };
    if (ruleDates(this.ruleOf(columns), semester.startDate).length === 0) {
      throw invalid(
        'NO_MEETINGS',
        'These settings give no class meetings at all. Check the day and the dates.',
      );
    }
    const summary = {
      sections: sectionIds.map((id) => `${sections.get(id)!.course.code} ${sections.get(id)!.code}`),
      lecturer: lecturer.fullName,
      room: room.code,
      ...this.columnsSummary(columns),
    };
    return { columns, sectionIds, summary };
  }

  private ruleOf(e: {
    recurrence: EntryRow['recurrence'];
    dayOfWeek: number;
    effectiveFrom: Date;
    effectiveTo: Date;
    selectedWeeks: number[];
  }) {
    return {
      recurrence: e.recurrence,
      dayOfWeek: e.dayOfWeek,
      effectiveFrom: toDay(e.effectiveFrom),
      effectiveTo: toDay(e.effectiveTo),
      selectedWeeks: e.selectedWeeks,
    };
  }

  private columnsSummary(e: {
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
    recurrence: string;
    selectedWeeks: number[];
    effectiveFrom: Date;
    effectiveTo: Date;
  }) {
    return {
      dayOfWeek: e.dayOfWeek,
      startTime: toHhmm(e.startMinute),
      endTime: toHhmm(e.endMinute),
      recurrence: e.recurrence,
      selectedWeeks: e.selectedWeeks,
      effectiveFrom: toDay(e.effectiveFrom),
      effectiveTo: toDay(e.effectiveTo),
    };
  }

  private async draft(id: string) {
    const timetable = await this.prisma.timetable.findUnique({ where: { id } });
    if (!timetable) throw notFound();
    if (timetable.status !== 'DRAFT') {
      throw conflict(
        'NOT_DRAFT',
        'Only a draft timetable can be changed here. Editing a published timetable comes with the class lifecycle.',
      );
    }
    return timetable;
  }

  private async findEntry(id: string) {
    const entry = await this.prisma.timetableEntry.findUnique({ where: { id }, include: entryInclude });
    if (!entry) throw notFound('timetable entry');
    return entry;
  }

  /** An administrator may change an entry only if every section in it is within their scope. */
  private async assertEntryScope(actor: AccessClaims, entry: EntryRow) {
    const sections = await this.courses.sectionSummaries(entry.sections.map((s) => s.sectionId));
    for (const s of sections.values()) await this.access.assertDepartment(actor, s.department);
  }

  private async change(
    tx: Tx,
    timetableId: string,
    entryId: string | null,
    changeType: string,
    actor: AccessClaims,
    before: object | null,
    after: object | null,
    reason?: string,
  ) {
    await tx.timetableChange.create({
      data: {
        timetableId,
        entryId,
        changeType,
        before: (before ?? Prisma.DbNull) as Prisma.InputJsonValue,
        after: (after ?? Prisma.DbNull) as Prisma.InputJsonValue,
        reason,
        changedById: actor.userId,
      },
    });
  }

  private async entryView(id: string) {
    const entry = await this.findEntry(id);
    return (await this.entryViews([entry]))[0]!;
  }

  private async entryViews(entries: EntryRow[]) {
    const sectionIds = entries.flatMap((e) => e.sections.map((s) => s.sectionId));
    const [sections, lecturers, rooms] = await Promise.all([
      this.courses.sectionSummaries(sectionIds),
      this.lecturers.facts(entries.map((e) => e.lecturerId)),
      this.places.classroomFacts(entries.map((e) => e.classroomId)),
    ]);
    return entries.map((e) => {
      const sectionList = e.sections.map((s) => {
        const info = sections.get(s.sectionId)!;
        return { id: info.id, code: info.code, course: info.course };
      });
      const lecturer = lecturers.get(e.lecturerId);
      const room = rooms.get(e.classroomId);
      const time = `${DAY_NAMES[e.dayOfWeek - 1]} ${toHhmm(e.startMinute)}–${toHhmm(e.endMinute)}`;
      return {
        id: e.id,
        version: e.version,
        isCancelled: e.isCancelled,
        sections: sectionList,
        lecturer: lecturer
          ? { id: lecturer.id, fullName: lecturer.fullName, staffNumber: lecturer.staffNumber }
          : null,
        classroom: room ? { id: room.id, code: room.code, name: room.name, capacity: room.capacity } : null,
        ...this.columnsSummary(e),
        exceptions: e.exceptions.map((x) => ({ id: x.id, date: toDay(x.date), reason: x.reason })),
        label: `${sectionList.map((s) => `${s.course.code} ${s.code}`).join(' + ')} (${time}, ${room?.code ?? 'room?'})`,
      };
    });
  }
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CLASH_TEXT = {
  ROOM_CLASH: 'Same room',
  LECTURER_CLASH: 'Same lecturer',
  SECTION_CLASH: 'Same section',
} as const;
const exceptionsOf = (e: EntryRow) => new Map(e.exceptions.map((x) => [toDay(x.date), x.reason]));
const versionConflict = (current: number) =>
  new ConflictException({
    code: 'VERSION_CONFLICT',
    message: 'Someone else changed this entry since you opened it. Reload it and try again.',
    errors: { currentVersion: current },
  });
