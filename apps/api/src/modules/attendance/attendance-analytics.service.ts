import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AttendanceGroup } from '@attendsure/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicAccessService } from '../academic/academic-access.service.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** The column each grouping uses, and how its rows are labelled. */
const GROUP: Record<AttendanceGroup, { key: Prisma.Sql; label: Prisma.Sql; join: Prisma.Sql }> = {
  faculty: {
    key: Prisma.sql`x.faculty_id`,
    label: Prisma.sql`f.code || ' · ' || f.name`,
    join: Prisma.sql`JOIN faculties f ON f.id = g.key`,
  },
  department: {
    key: Prisma.sql`x.department_id`,
    label: Prisma.sql`d.code || ' · ' || d.name`,
    join: Prisma.sql`JOIN departments d ON d.id = g.key`,
  },
  programme: {
    key: Prisma.sql`x.programme_id`,
    label: Prisma.sql`p.code || ' · ' || p.name`,
    join: Prisma.sql`JOIN programmes p ON p.id = g.key`,
  },
  level: {
    key: Prisma.sql`x.level_id`,
    label: Prisma.sql`l.code || ' · ' || l.name`,
    join: Prisma.sql`JOIN academic_levels l ON l.id = g.key`,
  },
  course: {
    key: Prisma.sql`x.course_id`,
    label: Prisma.sql`c.code || ' · ' || c.title`,
    join: Prisma.sql`JOIN courses c ON c.id = g.key`,
  },
  lecturer: {
    key: Prisma.sql`x.lecturer_id`,
    label: Prisma.sql`u.full_name || ' (' || lp.staff_number || ')'`,
    join: Prisma.sql`JOIN lecturer_profiles lp ON lp.id = g.key JOIN users u ON u.id = lp.user_id`,
  },
};

interface Row {
  key: string;
  label: string;
  students: bigint;
  present: bigint;
  late: bigint;
  absences: bigint;
  excused: bigint;
  undecided: bigint;
  below: bigint | null;
}

/**
 * Attendance analytics for administrators (Phase 7 step 1): a semester's attendance grouped by faculty,
 * department, programme, level, course or lecturer, within the caller's scope (by the course's
 * department). The same rules as each student's own percentage (ATTENDANCE_FLOW §9, calculation.ts):
 * a record counts when its class was held (COMPLETED), attendance was taken and closed, it was not
 * voided, and the student was enrolled in one of the class's sections at its start. Present plus late
 * (weighted) over present, late and absences; excused and undecided are left out. Worked out from the
 * records when asked (raw SQL with bound parameters; read only).
 */
@Injectable()
export class AttendanceAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly access: AcademicAccessService,
    private readonly lookups: AcademicLookupsService,
  ) {}

  async attendance(actor: AccessClaims, semesterId: string | undefined, groupBy: AttendanceGroup) {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'UNIVERSITY_ADMIN') {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Analytics are for administrators.',
      });
    }
    const semester = await this.semesterFor(semesterId);
    const result = await this.compute(actor, groupBy, Prisma.sql`o.semester_id = ${semester.id}::uuid`);
    return { semester: { id: semester.id, name: semester.name, status: semester.status }, ...result };
  }

  /**
   * Attendance for classes that started between two moments (any semester), within the caller's scope:
   * the administrator dashboard's "this week". Same rules as `attendance`.
   */
  async totalsBetween(actor: AccessClaims, from: Date, to: Date) {
    const result = await this.compute(
      actor,
      'department',
      Prisma.sql`cs.scheduled_start >= ${from} AND cs.scheduled_start < ${to}`,
    );
    return { ...result.totals, departments: result.rows.length };
  }

  private async compute(actor: AccessClaims, groupBy: AttendanceGroup, window: Prisma.Sql) {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'UNIVERSITY_ADMIN') {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'Analytics are for administrators.',
      });
    }
    const [lateWeight, minimumPercent] = await Promise.all([
      this.settings.get('attendance.lateWeight'),
      this.settings.get('attendance.minimumPercent'),
    ]);
    const scope = await this.access.scopeOf(actor);
    const inScope = scope.institutionWide
      ? Prisma.sql`TRUE`
      : Prisma.sql`(c.department_id = ANY(${scope.departmentIds}::uuid[]) OR d.faculty_id = ANY(${scope.facultyIds}::uuid[]))`;
    const g = GROUP[groupBy];
    const below =
      minimumPercent === null
        ? Prisma.sql`NULL::bigint`
        : Prisma.sql`COUNT(*) FILTER (
            WHERE (s.present + s.late + s.absences) > 0
              AND (s.present + ${lateWeight}::float8 * s.late) * 100 / (s.present + s.late + s.absences) < ${minimumPercent}::float8)`;
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH counted AS (
        -- One row per counted record; DISTINCT ON keeps a student enrolled in two sections of a
        -- combined class from being counted twice.
        SELECT DISTINCT ON (r.id)
               r.id, r.student_id, r.status, cs.lecturer_id,
               c.id AS course_id, c.department_id, d.faculty_id, sp.programme_id, sp.level_id
          FROM attendance_records r
          JOIN class_sessions cs ON cs.id = r.class_session_id AND cs.status = 'COMPLETED'
          JOIN attendance_sessions a ON a.id = r.attendance_session_id
               AND a.status = 'CLOSED' AND a.close_reason IS DISTINCT FROM 'CLASS_VOIDED'
          JOIN class_session_sections css ON css.class_session_id = cs.id
          JOIN course_enrollments e ON e.student_id = r.student_id AND e.section_id = css.section_id
               AND e.enrolled_at <= cs.scheduled_start
               AND (e.ended_at IS NULL OR e.ended_at > cs.scheduled_start)
          JOIN course_sections sec ON sec.id = e.section_id
          JOIN course_offerings o ON o.id = sec.offering_id
          JOIN courses c ON c.id = o.course_id
          JOIN departments d ON d.id = c.department_id
          JOIN student_profiles sp ON sp.id = r.student_id
         WHERE r.status <> 'VOIDED' AND ${inScope} AND ${window}
         ORDER BY r.id
      ),
      x AS (SELECT * FROM counted),
      per_student AS (
        SELECT ${g.key} AS key, x.student_id,
               COUNT(*) FILTER (WHERE x.status = 'PRESENT') AS present,
               COUNT(*) FILTER (WHERE x.status = 'LATE') AS late,
               COUNT(*) FILTER (WHERE x.status IN ('ABSENT', 'REJECTED')) AS absences,
               COUNT(*) FILTER (WHERE x.status = 'EXCUSED') AS excused,
               COUNT(*) FILTER (WHERE x.status IN ('PENDING', 'UNDER_REVIEW')) AS undecided
          FROM x
         GROUP BY ${g.key}, x.student_id
      ),
      g AS (
        SELECT s.key,
               COUNT(*) AS students,
               SUM(s.present)::bigint AS present, SUM(s.late)::bigint AS late,
               SUM(s.absences)::bigint AS absences, SUM(s.excused)::bigint AS excused,
               SUM(s.undecided)::bigint AS undecided,
               ${below} AS below
          FROM per_student s
         GROUP BY s.key
      )
      SELECT g.key::text AS key, ${g.label} AS label, g.students, g.present, g.late, g.absences,
             g.excused, g.undecided, g.below
        FROM g ${g.join}
       ORDER BY label
    `);
    const lines = rows.map((r) => line(r, lateWeight, minimumPercent));
    const sum = (k: 'present' | 'late' | 'absences' | 'excused' | 'undecided') =>
      lines.reduce((n, l) => n + l[k], 0);
    const totals = {
      present: sum('present'),
      late: sum('late'),
      absences: sum('absences'),
      excused: sum('excused'),
      undecided: sum('undecided'),
    };
    return {
      groupBy,
      lateWeight,
      minimumPercent,
      scope: scope.institutionWide ? 'UNIVERSITY' : 'LIMITED',
      rows: lines,
      totals: { ...totals, percentage: percentage(totals, lateWeight) },
    };
  }

  private async semesterFor(semesterId: string | undefined) {
    const id = semesterId ?? (await this.lookups.currentSemesterId());
    const semester = id ? await this.lookups.semester(id) : null;
    if (!semester) {
      throw new NotFoundException({
        code: semesterId ? 'NOT_FOUND' : 'NO_ACTIVE_SEMESTER',
        message: semesterId ? 'No such semester.' : 'There is no active semester; choose one.',
      });
    }
    return semester;
  }
}

function percentage(
  t: { present: number; late: number; absences: number },
  lateWeight: number,
): number | null {
  const denominator = t.present + t.late + t.absences;
  return denominator > 0 ? Math.round(((t.present + lateWeight * t.late) / denominator) * 1000) / 10 : null;
}

function line(r: Row, lateWeight: number, minimumPercent: number | null) {
  const counts = {
    present: Number(r.present),
    late: Number(r.late),
    absences: Number(r.absences),
    excused: Number(r.excused),
    undecided: Number(r.undecided),
  };
  return {
    key: r.key,
    label: r.label,
    students: Number(r.students),
    ...counts,
    percentage: percentage(counts, lateWeight),
    /** Students whose own percentage in this group is under the minimum; null until a minimum is set. */
    belowMinimum: minimumPercent === null ? null : Number(r.below ?? 0),
  };
}
