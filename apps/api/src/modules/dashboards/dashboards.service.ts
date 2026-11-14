import { ForbiddenException, Injectable } from '@nestjs/common';
import { Clock } from '../../infrastructure/clock/clock.js';
import { AttendanceSummaryService } from '../attendance/attendance-summary.service.js';
import { AttendanceRecordsService } from '../attendance/records.service.js';
import type { AccessClaims } from '../auth/token.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { DisputesService } from '../requests/disputes.service.js';
import { SettingsService } from '../settings/settings.service.js';

const WEEK = 7 * 24 * 3_600_000;

/**
 * The lecturer's dashboard (Phase 6 step 6): what waits for them and how their sections are doing.
 * Every number is counted from the records when asked (CLAUDE.md rule 6); nothing is stored here.
 * Today's classes come from the timetable endpoint the screens already use.
 */
@Injectable()
export class DashboardsService {
  constructor(
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly lecturers: LecturersService,
    private readonly records: AttendanceRecordsService,
    private readonly summaries: AttendanceSummaryService,
    private readonly disputes: DisputesService,
  ) {}

  async lecturer(actor: AccessClaims) {
    const lecturerId = actor.role === 'LECTURER' ? await this.lecturers.idForUser(actor.userId) : null;
    if (!lecturerId) {
      throw new ForbiddenException({ code: 'NOT_A_LECTURER', message: 'This dashboard is for lecturers.' });
    }
    const since = new Date(this.clock.now().getTime() - WEEK);
    const teaching = await this.lecturers.myTeaching(actor.userId);
    const [disputes, counts, sections, minimumPercent] = await Promise.all([
      this.disputes.waitingFor(actor),
      this.records.lecturerCounts(lecturerId, actor.userId, since),
      Promise.all(teaching.sections.map((s) => this.summaries.sectionOverview(actor, s.sectionId))),
      this.settings.get('attendance.minimumPercent'),
    ]);
    return {
      waiting: {
        disputes,
        checkIns: counts.checkInsWaiting,
        corrections: { waiting: counts.correctionsWaiting, answeredThisWeek: counts.correctionsAnswered },
      },
      excusedThisWeek: counts.excused,
      sections,
      minimumPercent,
    };
  }
}
