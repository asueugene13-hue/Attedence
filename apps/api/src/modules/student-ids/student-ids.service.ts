import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ATTENDANCE_QR_PREFIX, STUDENT_ID_CHECKER_ROLES, STUDENT_ID_CODE } from '@attendsure/shared';
import { auditEntry } from '../../common/audit-entry.js';
import type { RequestContext } from '../../common/request-context.js';
import { AppConfig } from '../../config/app-config.js';
import { Clock } from '../../infrastructure/clock/clock.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { AuditService } from '../audit-logs/audit.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { StudentsService } from '../students/students.service.js';
import { idCodeKey, makeIdCode, newRef, readIdCode } from './id-code.js';

const refKey = (ref: string) => `student-id:ref:${ref}`;

/**
 * The digital student ID (Phase 6 step 5). The student's phone asks for its card while online and
 * gets a fresh code every 30 seconds; the code's random reference points to the student for 45
 * seconds only (kept in Redis, never in the code). A staff member's app sends a scanned code to
 * `check`, which says whether it is genuine and current and shows who it belongs to, with the photo
 * from the Registrar's record. Every check is in the audit log.
 */
@Injectable()
export class StudentIdsService {
  private readonly key: Buffer;

  constructor(
    config: AppConfig,
    private readonly clock: Clock,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly students: StudentsService,
  ) {
    this.key = idCodeKey(config.encryptionKey);
  }

  /** The signed-in student's card, with a fresh code. */
  async myCard(actor: AccessClaims) {
    const student = actor.role === 'STUDENT' ? await this.students.mine(actor.userId) : null;
    if (!student)
      throw new ForbiddenException({ code: 'NOT_A_STUDENT', message: 'Only students have a student ID.' });
    const now = this.clock.now();
    const ref = newRef();
    const expires = Math.floor(now.getTime() / 1000) + STUDENT_ID_CODE.validSeconds;
    await this.redis.client.set(refKey(ref), student.id, 'EX', STUDENT_ID_CODE.validSeconds);
    return {
      student: {
        fullName: student.fullName,
        studentNumber: student.studentNumber,
        programme: student.programme,
        level: student.level,
        status: student.status,
        hasPhoto: student.hasPhoto,
      },
      code: {
        value: makeIdCode(this.key, ref, expires),
        expiresAt: new Date(expires * 1000),
        refreshAfterSeconds: STUDENT_ID_CODE.refreshSeconds,
      },
    };
  }

  /** The signed-in student's own photo (a short-lived link), for the card. */
  async myPhoto(actor: AccessClaims) {
    if (actor.role !== 'STUDENT')
      throw new ForbiddenException({ code: 'NOT_A_STUDENT', message: 'Only students have a student ID.' });
    return this.students.photoLink({ userId: actor.userId });
  }

  /**
   * A staff member checks a scanned code. Returns `{ result: GENUINE | EXPIRED | NOT_GENUINE, … }`:
   * a genuine code shows the student (with `active`); anything else shows nobody.
   */
  async check(actor: AccessClaims, code: string, context: RequestContext) {
    if (!(STUDENT_ID_CHECKER_ROLES as readonly string[]).includes(actor.role)) {
      throw new ForbiddenException({ code: 'STAFF_ONLY', message: 'Only staff can check a student ID.' });
    }
    if (code.startsWith(`${ATTENDANCE_QR_PREFIX}.`)) {
      throw new BadRequestException({
        code: 'NOT_AN_ID_CODE',
        message: 'That is an attendance code, not a student ID. Ask the student to open their ID card.',
      });
    }
    const now = this.clock.now();
    const read = readIdCode(this.key, code);
    let result: 'GENUINE' | 'EXPIRED' | 'NOT_GENUINE' = 'NOT_GENUINE';
    let studentId: string | null = null;
    if (read) {
      studentId = read.expires * 1000 >= now.getTime() ? await this.redis.client.get(refKey(read.ref)) : null;
      result = studentId ? 'GENUINE' : 'EXPIRED';
    }
    const student = studentId ? (await this.students.summaries([studentId])).get(studentId) : undefined;
    if (!student) result = read ? 'EXPIRED' : 'NOT_GENUINE';
    await this.audit.record({
      ...auditEntry(
        actor,
        'student_ids.checked',
        { type: 'student', id: student?.id ?? '' },
        { after: { result, ...(student ? { active: student.status === 'ACTIVE' } : {}) } },
        context,
      ),
      // A code that is not genuine or has expired identifies nobody.
      entityId: student?.id ?? null,
    });
    if (!student) return { result, checkedAt: now, student: null, photo: null };
    return {
      result,
      checkedAt: now,
      /** From the Registrar's record (a short-lived link), so it can be compared with the person. */
      photo: await this.photoOf(student.id),
      student: {
        id: student.id,
        fullName: student.fullName,
        studentNumber: student.studentNumber,
        programme: student.programme,
        level: student.level,
        status: student.status,
        active: student.status === 'ACTIVE',
      },
    };
  }

  private async photoOf(studentId: string) {
    try {
      return await this.students.photoLink({ id: studentId });
    } catch (error) {
      if (error instanceof NotFoundException) return null; // no photo on record
      throw error;
    }
  }
}
