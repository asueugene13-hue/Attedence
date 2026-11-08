import { Injectable } from '@nestjs/common';
import { STUDENT_IMPORT_COLUMNS, StudentImportRowSchema, type StudentImportColumn } from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { StudentsService } from './students.service.js';

export interface RowProblem {
  column: string | null;
  code: string;
  message: string;
}

export type CheckedStatus = 'VALID' | 'INVALID' | 'DUPLICATE_IN_FILE' | 'DUPLICATE_EXISTING';

export interface StudentImportInput {
  studentNumber: string;
  fullName: string;
  email: string;
  phone: string;
  programmeId: string;
  levelId: string;
  academicYearId: string;
  semesterId: string;
  status: 'ACTIVE' | 'DEFERRED' | 'SUSPENDED' | 'WITHDRAWN' | 'GRADUATED';
  /** The email already has an account (for example a staff member), which gains the Student role. */
  existingAccount: boolean;
}

export interface CheckedRow {
  rowNumber: number;
  status: CheckedStatus;
  normalized: StudentImportInput | null;
  errors: RowProblem[];
}

/** Columns a re-uploaded error report carries in addition to the template's. */
export const REPORT_COLUMNS = ['row_number', 'problems'] as const;

const CHUNK = 1000;
const chunks = <T>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Checks student import rows against the same rules as single registration, using the codes and labels
 * staff entered in the academic structure. Nothing is written here; `importRows` saves confirmed rows.
 */
@Injectable()
export class StudentImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  /** Column problems that make the whole file unusable: missing required columns or unknown ones. */
  checkHeaders(headers: string[]): { missing: string[]; unknown: string[] } {
    const known = new Set<string>([...STUDENT_IMPORT_COLUMNS.map((c) => c.key), ...REPORT_COLUMNS]);
    return {
      missing: STUDENT_IMPORT_COLUMNS.filter((c) => c.required && !headers.includes(c.key)).map((c) => c.key),
      unknown: headers.filter((h) => h !== '' && !known.has(h)),
    };
  }

  async check(rows: { rowNumber: number; values: Record<string, string> }[]): Promise<CheckedRow[]> {
    const lookups = await this.loadLookups();
    const parsed = rows.map((row) => this.checkRow(row, lookups));
    this.markDuplicatesInFile(parsed);
    await this.markExisting(parsed);
    return parsed.map(({ rowNumber, status, normalized, errors }) => ({
      rowNumber,
      status,
      normalized,
      errors,
    }));
  }

  /** Saves already-checked VALID rows inside the caller's transaction, through the same path as single registration. */
  async importRows(
    tx: Prisma.TransactionClient,
    actor: AccessClaims,
    rows: { rowNumber: number; input: StudentImportInput }[],
    batchId: string,
    context: RequestContext,
  ) {
    const created: { rowNumber: number; profileId: string; newAccount: boolean }[] = [];
    for (const { rowNumber, input } of rows) {
      const { profileId, newAccount } = await this.students.registerInTx(tx, actor, input, context, {
        importBatchId: batchId,
        importRowNumber: rowNumber,
      });
      created.push({ rowNumber, profileId, newAccount });
    }
    return created;
  }

  /** True when an email was sent; false when the account was already activated. */
  sendActivation(profileId: string): Promise<boolean> {
    return this.students.sendActivationFor(profileId);
  }

  private async loadLookups() {
    const [programmes, levels, years] = await Promise.all([
      this.prisma.programme.findMany({ include: { department: { include: { faculty: true } } } }),
      this.prisma.academicLevel.findMany(),
      this.prisma.academicYear.findMany({ include: { semesters: true } }),
    ]);
    return {
      programmes: new Map(
        programmes
          .filter((p) => p.isActive && p.department.isActive && p.department.faculty.isActive)
          .map((p) => [p.code, p.id]),
      ),
      levels: new Map(levels.filter((l) => l.isActive).map((l) => [l.code, l.id])),
      years: new Map(years.map((y) => [y.label, y])),
    };
  }

  private checkRow(
    row: { rowNumber: number; values: Record<string, string> },
    lookups: Awaited<ReturnType<StudentImportService['loadLookups']>>,
  ) {
    const errors: RowProblem[] = [];
    const blank = new Set<StudentImportColumn>();
    for (const column of STUDENT_IMPORT_COLUMNS) {
      if (column.required && (row.values[column.key] ?? '').trim() === '') {
        blank.add(column.key);
        errors.push({ column: column.key, code: 'REQUIRED', message: `${column.key} is required` });
      }
    }
    const input = Object.fromEntries(STUDENT_IMPORT_COLUMNS.map((c) => [c.key, row.values[c.key] ?? '']));
    const result = StudentImportRowSchema.safeParse(input);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const column = String(issue.path[0] ?? '') as StudentImportColumn;
        if (blank.has(column)) continue;
        if (errors.some((e) => e.column === column)) continue;
        errors.push({ column, code: 'INVALID_VALUE', message: `${column} ${issue.message}` });
      }
    }
    let normalized: StudentImportInput | null = null;
    if (result.success) {
      const v = result.data;
      const programmeId = lookups.programmes.get(v.programme_code);
      const levelId = lookups.levels.get(v.level_code);
      const year = lookups.years.get(v.academic_year);
      const semester = year?.semesters.find((s) => s.number === v.semester_number);
      if (!programmeId) {
        errors.push(
          problem(
            'programme_code',
            'UNKNOWN_PROGRAMME',
            `No active programme has the code ${v.programme_code}.`,
          ),
        );
      }
      if (!levelId)
        errors.push(problem('level_code', 'UNKNOWN_LEVEL', `No active level has the code ${v.level_code}.`));
      if (!year) {
        errors.push(
          problem(
            'academic_year',
            'UNKNOWN_ACADEMIC_YEAR',
            `No academic year is labelled ${v.academic_year}.`,
          ),
        );
      } else if (!semester) {
        errors.push(
          problem(
            'semester_number',
            'UNKNOWN_SEMESTER',
            `${v.academic_year} has no semester ${v.semester_number}.`,
          ),
        );
      } else if (semester.status === 'CLOSED') {
        errors.push(problem('semester_number', 'SEMESTER_CLOSED', 'That semester is closed.'));
      }
      if (programmeId && levelId && year && semester && errors.length === 0) {
        normalized = {
          studentNumber: v.student_number,
          fullName: v.full_name,
          email: v.email,
          phone: v.phone,
          programmeId,
          levelId,
          academicYearId: year.id,
          semesterId: semester.id,
          status: v.status,
          existingAccount: false,
        };
      }
    }
    return {
      rowNumber: row.rowNumber,
      status: (errors.length > 0 ? 'INVALID' : 'VALID') as CheckedStatus,
      normalized,
      errors,
    };
  }

  /** Every row sharing a Student ID or email with another row is held back: it is unclear which one is right. */
  private markDuplicatesInFile(rows: CheckedRow[]) {
    for (const field of ['studentNumber', 'email'] as const) {
      const seen = new Map<string, number[]>();
      for (const row of rows) {
        if (!row.normalized) continue;
        const key = row.normalized[field];
        seen.set(key, [...(seen.get(key) ?? []), row.rowNumber]);
      }
      for (const row of rows) {
        if (!row.normalized) continue;
        const others = (seen.get(row.normalized[field]) ?? []).filter((n) => n !== row.rowNumber);
        if (others.length === 0) continue;
        row.status = 'DUPLICATE_IN_FILE';
        const column = field === 'studentNumber' ? 'student_number' : 'email';
        row.errors.push(problem(column, 'DUPLICATE_IN_FILE', `Same ${column} as row ${others.join(', ')}.`));
      }
    }
  }

  /** Rows whose Student ID or email already belongs to a student, or whose account is deactivated. */
  private async markExisting(rows: CheckedRow[]) {
    const candidates = rows.filter((r) => r.status === 'VALID' && r.normalized);
    const numbers = new Set<string>();
    const accounts = new Map<string, { isStudent: boolean; deactivated: boolean }>();
    for (const part of chunks(candidates)) {
      const found = await this.prisma.studentProfile.findMany({
        where: { studentNumber: { in: part.map((r) => r.normalized!.studentNumber) } },
        select: { studentNumber: true },
      });
      found.forEach((f) => numbers.add(f.studentNumber));
      const users = await this.prisma.user.findMany({
        where: { email: { in: part.map((r) => r.normalized!.email) } },
        select: { email: true, status: true, studentProfile: { select: { id: true } } },
      });
      users.forEach((u) =>
        accounts.set(u.email, {
          isStudent: u.studentProfile !== null,
          deactivated: u.status === 'DEACTIVATED',
        }),
      );
    }
    for (const row of candidates) {
      const input = row.normalized!;
      const account = accounts.get(input.email);
      if (numbers.has(input.studentNumber)) {
        row.status = 'DUPLICATE_EXISTING';
        row.errors.push(
          problem('student_number', 'STUDENT_NUMBER_IN_USE', 'Another student already has that Student ID.'),
        );
      } else if (account?.isStudent) {
        row.status = 'DUPLICATE_EXISTING';
        row.errors.push(problem('email', 'ALREADY_STUDENT', 'This email already belongs to a student.'));
      } else if (account?.deactivated) {
        row.status = 'INVALID';
        row.errors.push(problem('email', 'ACCOUNT_DEACTIVATED', 'That account is deactivated.'));
      } else {
        input.existingAccount = account !== undefined;
      }
    }
  }
}

const problem = (column: string, code: string, message: string): RowProblem => ({ column, code, message });
