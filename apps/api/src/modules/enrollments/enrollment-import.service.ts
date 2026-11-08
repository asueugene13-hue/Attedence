import { Injectable } from '@nestjs/common';
import { ENROLLMENT_IMPORT_COLUMNS, EnrollmentImportRowSchema } from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { CoursesService, sectionKey } from '../courses/courses.service.js';
import {
  basicRowProblems,
  type CheckedRow,
  type ImportHandler,
  markDuplicatesInFile,
  problem,
  type SheetValues,
} from '../imports/import-handler.js';
import { StudentsService } from '../students/students.service.js';
import { enrolmentBlocker, EnrollmentsService } from './enrollments.service.js';

export interface EnrollmentImportInput {
  studentId: string;
  sectionId: string;
  offeringId: string;
}

/** Bulk enrolment through the shared import pipeline, with the same rules as enrolling one student. */
@Injectable()
export class EnrollmentImportService implements ImportHandler<EnrollmentImportInput> {
  readonly type = 'ENROLLMENTS' as const;
  readonly slug = 'enrollments';
  readonly permission = 'enrollments.manage' as const;
  readonly columns = ENROLLMENT_IMPORT_COLUMNS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    private readonly courses: CoursesService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  async check(rows: SheetValues[]): Promise<CheckedRow<EnrollmentImportInput>[]> {
    const parsed = rows.map((row) => {
      const input = Object.fromEntries(
        ENROLLMENT_IMPORT_COLUMNS.map((c) => [c.key, row.values[c.key] ?? '']),
      );
      const result = EnrollmentImportRowSchema.safeParse(input);
      return {
        row,
        data: result.success ? result.data : null,
        errors: basicRowProblems(
          ENROLLMENT_IMPORT_COLUMNS,
          row.values,
          result.success ? [] : result.error.issues,
        ),
      };
    });
    const valid = parsed.flatMap((p) => (p.data ? [p.data] : []));
    const [students, sections] = await Promise.all([
      this.students.byStudentNumbers(valid.map((v) => v.student_number)),
      this.courses.sectionsByCourseCodes(valid.map((v) => v.course_code)),
    ]);

    const checked: CheckedRow<EnrollmentImportInput>[] = parsed.map(({ row, data, errors }) => {
      let normalized: EnrollmentImportInput | null = null;
      if (data && errors.length === 0) {
        const student = students.get(data.student_number);
        const section = sections.get(
          sectionKey(data.course_code, data.academic_year, data.semester_number, data.section_code),
        );
        const blocked = enrolmentBlocker(student, section);
        if (blocked?.code === 'UNKNOWN_SECTION') {
          errors.push(
            problem(
              'section_code',
              'UNKNOWN_SECTION',
              `No section ${data.section_code} of ${data.course_code} in ${data.academic_year} semester ${data.semester_number}.`,
            ),
          );
        } else if (blocked) {
          errors.push(
            problem(
              blocked.code.includes('STUDENT') ? 'student_number' : 'section_code',
              blocked.code,
              blocked.message,
            ),
          );
        } else {
          normalized = { studentId: student!.id, sectionId: section!.id, offeringId: section!.offeringId };
        }
      }
      return {
        rowNumber: row.rowNumber,
        status: errors.length > 0 ? 'INVALID' : 'VALID',
        normalized,
        errors,
      };
    });

    // The same student twice for one offering is held back, whichever sections the rows name.
    markDuplicatesInFile(
      checked,
      (r) => `${r.studentId}|${r.offeringId}`,
      'student_number',
      'student and course offering',
    );
    await this.markExisting(checked);
    await this.markOverCapacity(checked, sections);
    return checked;
  }

  async importRows(
    tx: Prisma.TransactionClient,
    actor: AccessClaims,
    rows: { rowNumber: number; input: EnrollmentImportInput }[],
    batchId: string,
    context: RequestContext,
  ) {
    const created: { rowNumber: number; entityId: string; needsActivationEmail: boolean }[] = [];
    for (const { rowNumber, input } of rows) {
      const enrolment = await this.enrollments.enrollInTx(tx, actor, input, context, {
        importBatchId: batchId,
        importRowNumber: rowNumber,
      });
      created.push({ rowNumber, entityId: enrolment.id, needsActivationEmail: false });
    }
    return created;
  }

  /** Students already holding an active enrolment in that offering. */
  private async markExisting(rows: CheckedRow<EnrollmentImportInput>[]) {
    const candidates = rows.filter((r) => r.status === 'VALID' && r.normalized);
    if (candidates.length === 0) return;
    const existing = await this.prisma.courseEnrollment.findMany({
      where: {
        status: 'ENROLLED',
        studentId: { in: candidates.map((r) => r.normalized!.studentId) },
        offeringId: { in: candidates.map((r) => r.normalized!.offeringId) },
      },
      select: { studentId: true, offeringId: true },
    });
    const taken = new Set(existing.map((e) => `${e.studentId}|${e.offeringId}`));
    for (const row of candidates) {
      if (!taken.has(`${row.normalized!.studentId}|${row.normalized!.offeringId}`)) continue;
      row.status = 'DUPLICATE_EXISTING';
      row.errors.push(
        problem(
          'student_number',
          'ALREADY_ENROLLED',
          'This student is already enrolled in this course offering.',
        ),
      );
    }
  }

  /** Rows that would push a section past its capacity, counted in file order after current enrolments. */
  private async markOverCapacity(
    rows: CheckedRow<EnrollmentImportInput>[],
    sections: Awaited<ReturnType<CoursesService['sectionsByCourseCodes']>>,
  ) {
    const capacity = new Map([...sections.values()].map((s) => [s.id, s]));
    const candidates = rows.filter((r) => r.status === 'VALID' && r.normalized);
    const sectionIds = [...new Set(candidates.map((r) => r.normalized!.sectionId))];
    if (sectionIds.length === 0) return;
    const counts = await this.prisma.courseEnrollment.groupBy({
      by: ['sectionId'],
      where: { sectionId: { in: sectionIds }, status: 'ENROLLED' },
      _count: true,
    });
    const used = new Map(counts.map((c) => [c.sectionId, c._count]));
    for (const row of candidates) {
      const section = capacity.get(row.normalized!.sectionId)!;
      if (section.capacity === null) continue;
      const next = (used.get(section.id) ?? 0) + 1;
      if (next > section.capacity) {
        row.status = 'INVALID';
        row.errors.push(
          problem(
            'section_code',
            'SECTION_FULL',
            `Section ${section.code} is full (${section.capacity} places).`,
          ),
        );
      } else {
        used.set(section.id, next);
      }
    }
  }
}
