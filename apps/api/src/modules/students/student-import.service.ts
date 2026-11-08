import { Injectable } from '@nestjs/common';
import { STUDENT_IMPORT_COLUMNS, StudentImportRowSchema } from '@attendsure/shared';
import type { RequestContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AcademicLookupsService } from '../academic/academic-lookups.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import {
  basicRowProblems,
  type CheckedRow,
  type CheckedStatus,
  type ImportHandler,
  markDuplicatesInFile,
  problem,
  type SheetValues,
} from '../imports/import-handler.js';
import { AccountsService } from '../users/accounts.service.js';
import { StudentsService } from './students.service.js';

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

const CHUNK = 1000;
const chunks = <T>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Checks student import rows against the same rules as single registration, using the codes and labels
 * staff entered in the academic structure. Nothing is written here; `importRows` saves confirmed rows.
 */
@Injectable()
export class StudentImportService implements ImportHandler<StudentImportInput> {
  readonly type = 'STUDENTS' as const;
  readonly slug = 'students';
  readonly permission = 'students.import' as const;
  readonly columns = STUDENT_IMPORT_COLUMNS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    private readonly academic: AcademicLookupsService,
    private readonly accounts: AccountsService,
  ) {}

  async check(rows: SheetValues[]): Promise<CheckedRow<StudentImportInput>[]> {
    const lookups = await this.loadLookups();
    const parsed = rows.map((row) => this.checkRow(row, lookups));
    // Every row sharing a Student ID or email with another row is held back.
    markDuplicatesInFile(parsed, (r) => r.studentNumber, 'student_number', 'student_number');
    markDuplicatesInFile(parsed, (r) => r.email, 'email', 'email');
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
    const created: { rowNumber: number; entityId: string; needsActivationEmail: boolean }[] = [];
    for (const { rowNumber, input } of rows) {
      const { profileId, newAccount } = await this.students.registerInTx(tx, actor, input, context, {
        importBatchId: batchId,
        importRowNumber: rowNumber,
      });
      created.push({ rowNumber, entityId: profileId, needsActivationEmail: newAccount });
    }
    return created;
  }

  /** True when an email was sent; false when the account was already activated. */
  sendActivation(profileId: string): Promise<boolean> {
    return this.students.sendActivationFor(profileId);
  }

  private loadLookups() {
    return this.academic.importLookups();
  }

  private checkRow(row: SheetValues, lookups: Awaited<ReturnType<StudentImportService['loadLookups']>>) {
    const input = Object.fromEntries(STUDENT_IMPORT_COLUMNS.map((c) => [c.key, row.values[c.key] ?? '']));
    const result = StudentImportRowSchema.safeParse(input);
    const errors = basicRowProblems(
      STUDENT_IMPORT_COLUMNS,
      row.values,
      result.success ? [] : result.error.issues,
    );
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

  /** Rows whose Student ID or email already belongs to a student, or whose account is deactivated. */
  private async markExisting(rows: CheckedRow<StudentImportInput>[]) {
    const candidates = rows.filter((r) => r.status === 'VALID' && r.normalized);
    const numbers = new Set<string>();
    const accounts = new Map<string, { isStudent: boolean; deactivated: boolean }>();
    for (const part of chunks(candidates)) {
      const found = await this.prisma.studentProfile.findMany({
        where: { studentNumber: { in: part.map((r) => r.normalized!.studentNumber) } },
        select: { studentNumber: true },
      });
      found.forEach((f) => numbers.add(f.studentNumber));
      const users = await this.accounts.byEmails(part.map((r) => r.normalized!.email));
      const studentUsers = new Set(
        (
          await this.prisma.studentProfile.findMany({
            where: { userId: { in: [...users.values()].map((u) => u.id) } },
            select: { userId: true },
          })
        ).map((p) => p.userId),
      );
      for (const u of users.values()) {
        accounts.set(u.email, { isStudent: studentUsers.has(u.id), deactivated: u.status === 'DEACTIVATED' });
      }
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
