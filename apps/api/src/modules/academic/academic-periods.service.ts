import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateAcademicYearSchema,
  CreateCalendarExceptionSchema,
  CreateSemesterSchema,
  UpdateAcademicYearSchema,
  UpdateSemesterSchema,
} from '@attendsure/shared';
import type { z } from 'zod';
import { rethrowAsConflict } from '../../common/db-errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { AppConfig } from '../../config/app-config.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { OutboxService } from '../../infrastructure/jobs/outbox.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { AcademicAccessService } from './academic-access.service.js';

/** 'YYYY-MM-DD' → the Date Prisma stores in a `date` column (midnight UTC). */
const toDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** A stored `date` → 'YYYY-MM-DD'. */
export const toDay = (date: Date) => date.toISOString().slice(0, 10);

const notFound = (what: string) => new NotFoundException({ code: 'NOT_FOUND', message: `No such ${what}.` });

const YEAR_CONFLICTS = {
  unique: { code: 'LABEL_IN_USE', message: 'Another academic year already has that label.' },
  academic_years_no_overlap: {
    code: 'PERIOD_OVERLAP',
    message: 'These dates overlap another academic year.',
  },
  academic_years_one_current: {
    code: 'ANOTHER_YEAR_CURRENT',
    message: 'Another academic year is already current.',
  },
};
const SEMESTER_CONFLICTS = {
  unique: { code: 'NUMBER_IN_USE', message: 'This academic year already has a semester with that number.' },
  semesters_no_overlap: { code: 'PERIOD_OVERLAP', message: 'These dates overlap another semester.' },
  semesters_one_active: { code: 'ANOTHER_SEMESTER_ACTIVE', message: 'Another semester is already active.' },
};

/**
 * Academic years, semesters and calendar exceptions (holidays, closures, exam periods).
 * These shape the whole timetable, so only someone with university-wide scope may change them.
 */
@Injectable()
export class AcademicPeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AcademicAccessService,
    private readonly config: AppConfig,
    private readonly outbox: OutboxService,
  ) {}

  /** Today's date at the university (Africa/Accra), as YYYY-MM-DD. */
  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.config.institutionTimezone }).format(new Date());
  }

  // ───────── Academic years ─────────

  async listYears() {
    const years = await this.prisma.academicYear.findMany({
      orderBy: { startDate: 'desc' },
      include: { semesters: { orderBy: { number: 'asc' } } },
    });
    return years.map((y) => ({
      ...this.yearView(y),
      semesters: y.semesters.map((s) => this.semesterView(s)),
    }));
  }

  async createYear(
    actor: AccessClaims,
    input: z.output<typeof CreateAcademicYearSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const year = await tx.academicYear.create({
          data: { label: input.label, startDate: toDate(input.startDate), endDate: toDate(input.endDate) },
        });
        await this.record(
          tx,
          actor,
          'academic.year.created',
          'academic_year',
          year.id,
          null,
          this.yearView(year),
          context,
        );
        return this.yearView(year);
      })
      .catch((e: unknown) => rethrowAsConflict(e, YEAR_CONFLICTS));
  }

  async updateYear(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateAcademicYearSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const before = await tx.academicYear.findUnique({ where: { id }, include: { semesters: true } });
        if (!before) throw notFound('academic year');
        const start = input.startDate ?? toDay(before.startDate);
        const end = input.endDate ?? toDay(before.endDate);
        if (end <= start) throw this.badDates('endDate must be after startDate');
        const outside = before.semesters.find((s) => toDay(s.startDate) < start || toDay(s.endDate) > end);
        if (outside)
          throw this.badDates(`Semester ${outside.number} (${outside.name}) would fall outside these dates.`);
        const after = await tx.academicYear.update({
          where: { id },
          data: { label: input.label, startDate: toDate(start), endDate: toDate(end) },
        });
        await this.record(
          tx,
          actor,
          'academic.year.updated',
          'academic_year',
          id,
          this.yearView(before),
          this.yearView(after),
          context,
        );
        return this.yearView(after);
      })
      .catch((e: unknown) => rethrowAsConflict(e, YEAR_CONFLICTS));
  }

  /** Makes this the current academic year; the previous current year stops being current. */
  async makeYearCurrent(actor: AccessClaims, id: string, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma.$transaction(async (tx) => {
      const year = await tx.academicYear.findUnique({ where: { id } });
      if (!year) throw notFound('academic year');
      const previous = await tx.academicYear.findFirst({ where: { isCurrent: true } });
      if (previous?.id === id) return this.yearView(year);
      if (previous) await tx.academicYear.update({ where: { id: previous.id }, data: { isCurrent: false } });
      const after = await tx.academicYear.update({ where: { id }, data: { isCurrent: true } });
      await this.record(
        tx,
        actor,
        'academic.year.made_current',
        'academic_year',
        id,
        { previousCurrent: previous?.label ?? null },
        this.yearView(after),
        context,
      );
      return this.yearView(after);
    });
  }

  // ───────── Semesters ─────────

  async listSemesters(academicYearId?: string) {
    const semesters = await this.prisma.semester.findMany({
      where: academicYearId ? { academicYearId } : {},
      orderBy: { startDate: 'desc' },
      include: { academicYear: { select: { id: true, label: true } } },
    });
    return semesters.map((s) => ({ ...this.semesterView(s), academicYear: s.academicYear }));
  }

  async createSemester(
    actor: AccessClaims,
    input: z.output<typeof CreateSemesterSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const year = await tx.academicYear.findUnique({ where: { id: input.academicYearId } });
        if (!year) throw notFound('academic year');
        this.assertWithin(input.startDate, input.endDate, year, 'the academic year');
        const semester = await tx.semester.create({
          data: {
            academicYearId: input.academicYearId,
            number: input.number,
            name: input.name,
            startDate: toDate(input.startDate),
            endDate: toDate(input.endDate),
          },
        });
        await this.record(
          tx,
          actor,
          'academic.semester.created',
          'semester',
          semester.id,
          null,
          this.semesterView(semester),
          context,
        );
        return this.semesterView(semester);
      })
      .catch((e: unknown) => rethrowAsConflict(e, SEMESTER_CONFLICTS));
  }

  async updateSemester(
    actor: AccessClaims,
    id: string,
    input: z.output<typeof UpdateSemesterSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const before = await tx.semester.findUnique({ where: { id }, include: { academicYear: true } });
        if (!before) throw notFound('semester');
        const changingDates = input.startDate !== undefined || input.endDate !== undefined;
        if (changingDates && before.status !== 'PLANNED') {
          throw new ConflictException({
            code: 'SEMESTER_NOT_PLANNED',
            message: 'Dates can only change while a semester is still planned.',
          });
        }
        const start = input.startDate ?? toDay(before.startDate);
        const end = input.endDate ?? toDay(before.endDate);
        if (end <= start) throw this.badDates('endDate must be after startDate');
        this.assertWithin(start, end, before.academicYear, 'the academic year');
        const after = await tx.semester.update({
          where: { id },
          data: { name: input.name, startDate: toDate(start), endDate: toDate(end) },
        });
        await this.record(
          tx,
          actor,
          'academic.semester.updated',
          'semester',
          id,
          this.semesterView(before),
          this.semesterView(after),
          context,
        );
        return this.semesterView(after);
      })
      .catch((e: unknown) => rethrowAsConflict(e, SEMESTER_CONFLICTS));
  }

  /** Starts a planned semester. Only one may be active; its academic year becomes the current year. */
  async activateSemester(actor: AccessClaims, id: string, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma
      .$transaction(async (tx) => {
        const semester = await tx.semester.findUnique({ where: { id } });
        if (!semester) throw notFound('semester');
        if (semester.status !== 'PLANNED') {
          throw new ConflictException({
            code: 'SEMESTER_NOT_PLANNED',
            message: 'Only a planned semester can be started.',
          });
        }
        const active = await tx.semester.findFirst({ where: { status: 'ACTIVE' } });
        if (active) {
          throw new ConflictException({
            code: 'ANOTHER_SEMESTER_ACTIVE',
            message: `${active.name} is still active. Close it first.`,
          });
        }
        await tx.academicYear.updateMany({
          where: { isCurrent: true, id: { not: semester.academicYearId } },
          data: { isCurrent: false },
        });
        await tx.academicYear.update({ where: { id: semester.academicYearId }, data: { isCurrent: true } });
        const after = await tx.semester.update({ where: { id }, data: { status: 'ACTIVE' } });
        await this.record(
          tx,
          actor,
          'academic.semester.activated',
          'semester',
          id,
          { status: 'PLANNED' },
          { status: 'ACTIVE' },
          context,
        );
        return this.semesterView(after);
      })
      .catch((e: unknown) => rethrowAsConflict(e, SEMESTER_CONFLICTS));
  }

  async closeSemester(actor: AccessClaims, id: string, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma.$transaction(async (tx) => {
      const semester = await tx.semester.findUnique({ where: { id } });
      if (!semester) throw notFound('semester');
      if (semester.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'SEMESTER_NOT_ACTIVE',
          message: 'Only the active semester can be closed.',
        });
      }
      const after = await tx.semester.update({ where: { id }, data: { status: 'CLOSED' } });
      await this.record(
        tx,
        actor,
        'academic.semester.closed',
        'semester',
        id,
        { status: 'ACTIVE' },
        { status: 'CLOSED' },
        context,
      );
      return this.semesterView(after);
    });
  }

  // ───────── Calendar exceptions ─────────

  async listExceptions(filter: { semesterId?: string; from?: string; to?: string }) {
    const rows = await this.prisma.calendarException.findMany({
      where: {
        ...(filter.semesterId ? { semesterId: filter.semesterId } : {}),
        ...(filter.to ? { startDate: { lte: toDate(filter.to) } } : {}),
        ...(filter.from ? { endDate: { gte: toDate(filter.from) } } : {}),
      },
      orderBy: { startDate: 'asc' },
    });
    return rows.map((r) => this.exceptionView(r));
  }

  async createException(
    actor: AccessClaims,
    input: z.output<typeof CreateCalendarExceptionSchema>,
    context: RequestContext,
  ) {
    await this.access.assertInstitutionWide(actor);
    return this.prisma.$transaction(async (tx) => {
      if (input.semesterId) {
        const semester = await tx.semester.findUnique({ where: { id: input.semesterId } });
        if (!semester) throw notFound('semester');
        this.assertWithin(input.startDate, input.endDate, semester, 'the semester');
      }
      const row = await tx.calendarException.create({
        data: {
          semesterId: input.semesterId ?? null,
          type: input.type,
          name: input.name,
          startDate: toDate(input.startDate),
          endDate: toDate(input.endDate),
          suppressesClasses: input.suppressesClasses,
          createdById: actor.userId,
        },
      });
      await this.record(
        tx,
        actor,
        'academic.calendar_exception.created',
        'calendar_exception',
        row.id,
        null,
        this.exceptionView(row),
        context,
      );
      if (row.suppressesClasses) await this.announceCalendarChange(tx, row, actor);
      return this.exceptionView(row);
    });
  }

  /** Removes a holiday or closure that has not started yet. Past ones stay, because past classes depended on them. */
  async removeException(actor: AccessClaims, id: string, reason: string, context: RequestContext) {
    await this.access.assertInstitutionWide(actor);
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.calendarException.findUnique({ where: { id } });
      if (!row) throw notFound('calendar entry');
      if (toDay(row.startDate) <= this.today()) {
        throw new ConflictException({
          code: 'ALREADY_STARTED',
          message: 'This entry has already started, so it stays in the record.',
        });
      }
      await tx.calendarException.delete({ where: { id } });
      if (row.suppressesClasses) await this.announceCalendarChange(tx, row, actor);
      await this.record(
        tx,
        actor,
        'academic.calendar_exception.removed',
        'calendar_exception',
        id,
        this.exceptionView(row),
        {},
        context,
        reason,
      );
    });
  }

  // ───────── Helpers ─────────

  private assertWithin(start: string, end: string, outer: { startDate: Date; endDate: Date }, what: string) {
    if (start < toDay(outer.startDate) || end > toDay(outer.endDate)) {
      throw this.badDates(
        `The dates must fall within ${what} (${toDay(outer.startDate)} to ${toDay(outer.endDate)}).`,
      );
    }
  }

  private badDates(message: string) {
    return new BadRequestException({ code: 'INVALID_DATES', message });
  }

  private yearView(y: { id: string; label: string; startDate: Date; endDate: Date; isCurrent: boolean }) {
    return {
      id: y.id,
      label: y.label,
      startDate: toDay(y.startDate),
      endDate: toDay(y.endDate),
      isCurrent: y.isCurrent,
    };
  }

  private semesterView(s: {
    id: string;
    academicYearId: string;
    number: number;
    name: string;
    startDate: Date;
    endDate: Date;
    status: string;
  }) {
    return {
      id: s.id,
      academicYearId: s.academicYearId,
      number: s.number,
      name: s.name,
      startDate: toDay(s.startDate),
      endDate: toDay(s.endDate),
      status: s.status,
    };
  }

  private exceptionView(r: {
    id: string;
    semesterId: string | null;
    type: string;
    name: string;
    startDate: Date;
    endDate: Date;
    suppressesClasses: boolean;
  }) {
    return {
      id: r.id,
      semesterId: r.semesterId,
      type: r.type,
      name: r.name,
      startDate: toDay(r.startDate),
      endDate: toDay(r.endDate),
      suppressesClasses: r.suppressesClasses,
    };
  }

  /**
   * Days without classes changed: queue the job that brings published class sessions in line
   * (the class-sessions module owns that work). Queued in the same transaction, so it runs only if
   * the change is saved.
   */
  private async announceCalendarChange(
    tx: Prisma.TransactionClient,
    row: { semesterId: string | null; startDate: Date; endDate: Date },
    actor: AccessClaims,
  ) {
    await this.outbox.add(tx, 'system', 'calendar-changed', {
      semesterId: row.semesterId,
      from: toDay(row.startDate),
      to: toDay(row.endDate),
      changedById: actor.userId,
    });
  }

  private async record(
    tx: Prisma.TransactionClient,
    actor: AccessClaims,
    action: string,
    entityType: string,
    entityId: string,
    before: object | null,
    after: object,
    context: RequestContext,
    reason?: string,
  ) {
    await this.audit.record(
      {
        action,
        entityType,
        entityId,
        actorUserId: actor.userId,
        actorRoleKey: actor.role,
        before: before ? JSON.parse(JSON.stringify(before)) : undefined,
        after: JSON.parse(JSON.stringify(after)),
        reason,
        context,
      },
      tx,
    );
  }
}
