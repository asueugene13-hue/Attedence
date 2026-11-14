import { ForbiddenException, Injectable } from '@nestjs/common';
import { dayIn, wallClockToUtc } from '../../common/time-zone.js';
import { AppConfig } from '../../config/app-config.js';
import { AttendanceAnalyticsService } from '../attendance/attendance-analytics.service.js';
import { CorrectionsService } from '../attendance/corrections.service.js';
import { PermissionService } from '../authorization/permission.service.js';
import { BeaconsService } from '../beacons/beacons.service.js';
import { ClassAnalyticsService } from '../class-sessions/class-analytics.service.js';
import { ClassReviewsService } from '../class-sessions/class-reviews.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { ExcusesService } from '../requests/excuses.service.js';
import { RiskFlagsService } from '../risk-flags/risk-flags.service.js';
import { SystemHealthService } from '../settings/system-health.service.js';
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
    private readonly config: AppConfig,
    private readonly permissions: PermissionService,
    private readonly attendanceAnalytics: AttendanceAnalyticsService,
    private readonly classAnalytics: ClassAnalyticsService,
    private readonly reviews: ClassReviewsService,
    private readonly excuses: ExcusesService,
    private readonly corrections: CorrectionsService,
    private readonly riskFlags: RiskFlagsService,
    private readonly devices: DevicesService,
    private readonly beacons: BeaconsService,
    private readonly health: SystemHealthService,
  ) {}

  /**
   * The administrator's dashboard (Phase 7 step 3): today's classes by status, the last 7 days'
   * attendance, and everything waiting for a decision, each counted by the module that owns it within
   * the administrator's scope. Items the role may not act on are left out (null), never guessed.
   */
  async admin(actor: AccessClaims) {
    if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'UNIVERSITY_ADMIN') {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'This dashboard is for administrators.',
      });
    }
    const held = await this.permissions.forRole(actor.role);
    const tz = this.config.institutionTimezone;
    const today = dayIn(this.clock.now(), tz);
    const dayStart = wallClockToUtc(today, 0, tz);
    const dayEnd = wallClockToUtc(today, 24 * 60, tz);
    const weekStart = new Date(dayStart.getTime() - 6 * 24 * 3_600_000);
    // An item the role cannot act on (no permission, or a queue that needs a wider scope) is null.
    const when = async <T>(permission: string, count: () => Promise<T>): Promise<T | null> => {
      if (!held.has(permission)) return null;
      try {
        return await count();
      } catch (error) {
        if (error instanceof ForbiddenException) return null;
        throw error;
      }
    };
    const [
      todayClasses,
      week,
      classReviews,
      disputes,
      excuses,
      lateCorrections,
      riskFlags,
      phones,
      beacons,
      systemEvents,
    ] = await Promise.all([
      this.classAnalytics.statusCountsBetween(actor, dayStart, dayEnd),
      this.attendanceAnalytics.totalsBetween(actor, weekStart, dayEnd),
      when('class_reviews.decide', async () => {
        const open = (await this.reviews.list(actor, 'OPEN')).data;
        return { count: open.length, priority: open.filter((r) => r.isPriority).length };
      }),
      when('requests.review', async () => (await this.disputes.waitingFor(actor)).count),
      when('requests.review', async () => (await this.excuses.list(actor, 'OPEN')).data.length),
      when(
        'attendance.correct',
        async () => (await this.corrections.listRequests(actor, 'PENDING')).data.length,
      ),
      when(
        'risk_flags.review',
        async () => (await this.riskFlags.list(actor, { status: 'OPEN' })).data.length,
      ),
      when('devices.approve', async () => (await this.devices.list(actor, { requested: true })).data.length),
      when(
        'beacons.manage',
        async () => (await this.beacons.list({ status: 'SUSPECTED_FAULTY' })).data.length,
      ),
      when('system_health.read', () => this.health.unacknowledgedCount()),
    ]);
    return {
      today: { date: today, classes: todayClasses },
      lastSevenDays: { from: weekStart, ...week },
      waiting: { classReviews, disputes, excuses, lateCorrections, riskFlags, phoneApprovals: phones },
      beaconsSuspectedFaulty: beacons,
      unacknowledgedSystemEvents: systemEvents,
    };
  }

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
