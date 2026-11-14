import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClassGroup } from '@attendsure/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import type { AccessClaims } from '../auth/token.service.js';

const GROUP: Record<ClassGroup, { key: Prisma.Sql; label: Prisma.Sql; join: Prisma.Sql }> = {
  faculty: {
    key: Prisma.sql`d.faculty_id`,
    label: Prisma.sql`f.code || ' · ' || f.name`,
    join: Prisma.sql`JOIN faculties f ON f.id = t.key`,
  },
  department: {
    key: Prisma.sql`c.department_id`,
    label: Prisma.sql`dd.code || ' · ' || dd.name`,
    join: Prisma.sql`JOIN departments dd ON dd.id = t.key`,
  },
  course: {
    key: Prisma.sql`c.id`,
    label: Prisma.sql`cc.code || ' · ' || cc.title`,
    join: Prisma.sql`JOIN courses cc ON cc.id = t.key`,
  },
  lecturer: {
    key: Prisma.sql`cs.lecturer_id`,
    label: Prisma.sql`u.full_name || ' (' || lp.staff_number || ')'`,
    join: Prisma.sql`JOIN lecturer_profiles lp ON lp.id = t.key JOIN users u ON u.id = lp.user_id`,
  },
};

interface Row {
  key: string;
  label: string;
  scheduled: bigint;
  held: bigint;
  cancelled: bigint;
  rescheduled: bigint;
  suspended: bigint;
  still_to_come: bigint;
  delayed: bigint;
  unconfirmed: bigint;
  reviewed: bigint;
  late_start_minutes: number | null;
}

/**
 * Class operations for administrators (Phase 7 step 1): for a semester's classes, grouped by faculty,
 * department, course or lecturer, how many were held, cancelled, rescheduled or suspended, how many
 * had a delay reported, were marked unconfirmed or went to review, and how late held classes started
 * on average. Within the caller's scope (the course's department). Read only, from the class tables.
 */
@Injectable()
export class ClassAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicAccessService,
    private readonly lookups: AcademicLookupsService,
  ) {}

  /**
   * Classes scheduled between two moments, by status, within the caller's scope (the administrator
   * dashboard's "today"). A class serving several sections counts once.
   */
  async statusCountsBetween(actor: AccessClaims, from: Date, to: Date): Promise<Record<string, number>> {
    const scope = await this.access.scopeOf(actor);
    const inScope = scope.institutionWide
      ? Prisma.sql`TRUE`
      : Prisma.sql`(c.department_id = ANY(${scope.departmentIds}::uuid[]) OR d.faculty_id = ANY(${scope.facultyIds}::uuid[]))`;
    const rows = await this.prisma.$queryRaw<{ status: string; n: bigint }[]>(Prisma.sql`
      SELECT k.status::text AS status, COUNT(*) AS n FROM (
        SELECT DISTINCT cs.id, cs.status
          FROM class_sessions cs
          JOIN class_session_sections css ON css.class_session_id = cs.id
          JOIN course_sections sec ON sec.id = css.section_id
          JOIN course_offerings o ON o.id = sec.offering_id
          JOIN courses c ON c.id = o.course_id
          JOIN departments d ON d.id = c.department_id
         WHERE cs.scheduled_start >= ${from} AND cs.scheduled_start < ${to} AND ${inScope}
      ) k
      GROUP BY k.status
    `);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  async classes(actor: AccessClaims, semesterId: string | undefined, groupBy: ClassGroup) {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'UNIVERSITY_ADMIN') {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Analytics are for administrators.',
      });
    }
    const id = semesterId ?? (await this.lookups.currentSemesterId());
    const semester = id ? await this.lookups.semester(id) : null;
    if (!semester) {
      throw new NotFoundException({
        code: semesterId ? 'NOT_FOUND' : 'NO_ACTIVE_SEMESTER',
        message: semesterId ? 'No such semester.' : 'There is no active semester; choose one.',
      });
    }
    const scope = await this.access.scopeOf(actor);
    const inScope = scope.institutionWide
      ? Prisma.sql`TRUE`
      : Prisma.sql`(c.department_id = ANY(${scope.departmentIds}::uuid[]) OR d.faculty_id = ANY(${scope.facultyIds}::uuid[]))`;
    const g = GROUP[groupBy];
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH k AS (
        -- One row per class and group (a class serving two sections of one course counts once).
        SELECT DISTINCT cs.id, ${g.key} AS key, cs.status, cs.scheduled_start, cs.actual_start
          FROM class_sessions cs
          JOIN class_session_sections css ON css.class_session_id = cs.id
          JOIN course_sections sec ON sec.id = css.section_id
          JOIN course_offerings o ON o.id = sec.offering_id AND o.semester_id = ${semester.id}::uuid
          JOIN courses c ON c.id = o.course_id
          JOIN departments d ON d.id = c.department_id
         WHERE ${inScope}
      ),
      t AS (
        SELECT k.key,
               COUNT(*) AS scheduled,
               COUNT(*) FILTER (WHERE k.status = 'COMPLETED') AS held,
               COUNT(*) FILTER (WHERE k.status = 'CANCELLED') AS cancelled,
               COUNT(*) FILTER (WHERE k.status = 'RESCHEDULED') AS rescheduled,
               COUNT(*) FILTER (WHERE k.status = 'SUSPENDED') AS suspended,
               COUNT(*) FILTER (WHERE k.status NOT IN ('COMPLETED', 'CANCELLED', 'RESCHEDULED', 'SUSPENDED')) AS still_to_come,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM class_events e WHERE e.class_session_id = k.id AND e.type = 'DELAY_REPORTED')) AS delayed,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM class_events e WHERE e.class_session_id = k.id AND e.type = 'MARKED_UNCONFIRMED')) AS unconfirmed,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM class_status_reviews v WHERE v.class_session_id = k.id)) AS reviewed,
               AVG(GREATEST(0, EXTRACT(EPOCH FROM (k.actual_start - k.scheduled_start)) / 60))
                 FILTER (WHERE k.status = 'COMPLETED' AND k.actual_start IS NOT NULL)::float8 AS late_start_minutes
          FROM k
         GROUP BY k.key
      )
      SELECT t.key::text AS key, ${g.label} AS label, t.scheduled, t.held, t.cancelled, t.rescheduled,
             t.suspended, t.still_to_come, t.delayed, t.unconfirmed, t.reviewed, t.late_start_minutes
        FROM t ${g.join}
       ORDER BY label
    `);
    const lines = rows.map((r) => ({
      key: r.key,
      label: r.label,
      scheduled: Number(r.scheduled),
      held: Number(r.held),
      cancelled: Number(r.cancelled),
      rescheduled: Number(r.rescheduled),
      suspended: Number(r.suspended),
      stillToCome: Number(r.still_to_come),
      delayed: Number(r.delayed),
      unconfirmed: Number(r.unconfirmed),
      reviewed: Number(r.reviewed),
      averageLateStartMinutes:
        r.late_start_minutes === null ? null : Math.round(r.late_start_minutes * 10) / 10,
    }));
    return {
      semester: { id: semester.id, name: semester.name, status: semester.status },
      groupBy,
      scope: scope.institutionWide ? 'UNIVERSITY' : 'LIMITED',
      rows: lines,
    };
  }
}
