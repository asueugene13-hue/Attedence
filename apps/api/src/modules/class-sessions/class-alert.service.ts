import { Injectable, type OnModuleInit } from '@nestjs/common';
import { REVIEW_EMAIL_IF_UNREAD_MINUTES } from '@attendsure/shared';
import { AppConfig } from '../../config/app-config.js';
import type { ClassSession } from '../../generated/prisma/client.js';
import { JobRegistry } from '../../infrastructure/jobs/job-registry.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { ScopeService } from '../authorization/scope.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { LecturersService } from '../courses/lecturers.service.js';
import { CourseRepsService } from '../enrollments/course-reps.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { type NotifyInput, NotificationsService } from '../notifications/notifications.service.js';
import { PlacesService } from '../places/places.service.js';
import { StudentsService } from '../students/students.service.js';

type Session = ClassSession & { sections: { sectionId: string }[] };
type Message = Omit<NotifyInput, 'userIds' | 'dedupeKey' | 'related'>;

/** The buttons a lecturer gets when asked what is happening with a class (CLASS_MONITORING.md §1). */
const LECTURER_ACTIONS = ['start', 'delay', 'cancel', 'reschedule', 'report'];

/**
 * Decides who is told what about a class (CLASS_MONITORING.md §4) and hands the messages to the
 * notifications module. Runs as a job queued with each class event that people must hear about, so a
 * re-run never sends twice (each message has a key made from the event).
 */
@Injectable()
export class ClassAlertService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRegistry,
    private readonly notifications: NotificationsService,
    private readonly scopes: ScopeService,
    private readonly courses: CoursesService,
    private readonly lecturers: LecturersService,
    private readonly enrollments: EnrollmentsService,
    private readonly reps: CourseRepsService,
    private readonly students: StudentsService,
    private readonly places: PlacesService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.jobs.define<{ eventId: string }>({
      queue: 'system',
      name: 'class-alert',
      attempts: 5,
      handle: async (data) => {
        await this.alertFor(data.eventId);
      },
    });
    this.jobs.define<{ requestId: string; kind: 'created' | 'decided' }>({
      queue: 'system',
      name: 'reschedule-alert',
      attempts: 5,
      handle: async (data) => {
        await this.rescheduleAlert(data.requestId, data.kind);
      },
    });
  }

  async alertFor(eventId: string): Promise<void> {
    const event = await this.prisma.classEvent.findUnique({ where: { id: eventId } });
    if (!event) return;
    const session = await this.prisma.classSession.findUniqueOrThrow({
      where: { id: event.classSessionId },
      include: { sections: true },
    });
    const who = await this.audience(session);
    const label = await this.label(session);
    const when = this.when(session.expectedStart ?? session.scheduledStart);
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const path = `/classes/${session.id}`;
    const send = (userIds: string[], message: Message) =>
      this.notifications.notify({
        ...message,
        userIds,
        data: { path, sessionId: session.id, ...message.data },
        related: { type: 'class_session', id: session.id },
        dedupeKey: `class-event:${event.id}`,
      });
    const classPeople = [...who.students, ...who.reps];

    switch (event.type) {
      case 'LECTURER_PROMPTED':
        await send(who.lecturer, {
          category: 'CLASS_PROMPT',
          priority: 'HIGH',
          title: `${label}: what is happening with your class?`,
          body: `Students have reported a problem with your class at ${when}. Please start it, report a delay, cancel or reschedule it.`,
          data: { actions: LECTURER_ACTIONS },
        });
        break;
      case 'MARKED_UNCONFIRMED':
        await send(who.lecturer, {
          category: 'CLASS_UNCONFIRMED',
          priority: 'HIGH',
          title: `${label}: your class has not been confirmed`,
          body: `Your class at ${when} has not started. What is happening? Start it, report a delay, cancel or reschedule it.`,
          data: { actions: LECTURER_ACTIONS },
        });
        await send(who.reps, {
          category: 'CLASS_UNCONFIRMED',
          title: `${label}: the lecturer has been asked about the class`,
          body: `The class at ${when} has not started, and the lecturer has been asked what is happening.`,
        });
        break;
      case 'DELAY_REPORTED':
      case 'REVIEW_DECIDED':
        if (event.toStatus === 'POSTPONED') {
          await send(classPeople, {
            category: 'CLASS_DELAYED',
            priority: 'HIGH',
            title: `${label} is delayed`,
            body: `The class now starts at ${when}.${payload.reason ? ` Reason: ${String(payload.reason)}` : ''}`,
          });
        } else if (event.type === 'REVIEW_DECIDED') {
          await send(who.lecturer, {
            category: 'REVIEW_DECIDED',
            title: `${label}: review decided`,
            body: `An administrator decided the review of your class at ${when}. The class is now ${event.toStatus?.toLowerCase().replace('_', ' ')}.`,
          });
        }
        break;
      case 'ESCALATED':
        await send(who.lecturer, {
          category: 'CLASS_UNDER_REVIEW',
          priority: 'HIGH',
          title: `${label} has been referred for review`,
          body: `Your class at ${when} has been referred to an administrator for review. You can still start it.`,
          data: { actions: LECTURER_ACTIONS },
        });
        await send(classPeople, {
          category: 'CLASS_UNDER_REVIEW',
          title: `${label}: the university is checking on this class`,
          body: `The university is checking on the class at ${when}. You will be told what happens.`,
        });
        await send(who.admins, {
          category: 'REVIEW_OPENED',
          priority: payload.priority ? 'CRITICAL' : 'HIGH',
          title: `${payload.priority ? 'Priority: ' : ''}${label} needs review`,
          body: `The class at ${when} needs a decision. ${this.reasons(payload)}`,
          data: { path: '/class-reviews' },
          emailIfUnreadAfterMinutes: REVIEW_EMAIL_IF_UNREAD_MINUTES,
        });
        break;
      case 'CANCELLED': {
        const why = session.cancelNote ?? session.cancelReason?.toLowerCase().replaceAll('_', ' ') ?? '';
        const message: Message = {
          category: 'CLASS_CANCELLED',
          priority: 'CRITICAL',
          title: `${label} at ${when} is cancelled`,
          body: `The class at ${when} is cancelled.${why ? ` Reason: ${why}.` : ''}`,
        };
        await send([...classPeople, ...who.lecturer], message);
        await send(who.admins, { ...message, priority: 'NORMAL' });
        break;
      }
      case 'RESCHEDULED': {
        const newStart =
          typeof payload.newStart === 'string' ? this.when(new Date(payload.newStart)) : 'a new time';
        const room = await this.roomName(payload.newClassroomId);
        const message: Message = {
          category: 'CLASS_RESCHEDULED',
          priority: 'CRITICAL',
          title: `${label} moved to ${newStart}`,
          body: `The class at ${when} has been moved to ${newStart}${room ? `, ${room}` : ''}.`,
          data:
            typeof payload.replacementSessionId === 'string'
              ? { path: `/classes/${payload.replacementSessionId}` }
              : {},
        };
        await send([...classPeople, ...who.lecturer], message);
        await send(who.admins, { ...message, priority: 'NORMAL' });
        break;
      }
      case 'REINSTATED':
        await send([...classPeople, ...who.lecturer], {
          category: 'CLASS_REINSTATED',
          priority: 'CRITICAL',
          title: `${label} at ${when} is back on`,
          body: `The class at ${when} was cancelled by mistake and is back on.`,
        });
        break;
      case 'VENUE_CHANGED': {
        const room = (await this.roomName(session.classroomId)) ?? 'a new room';
        await send([...classPeople, ...who.lecturer], {
          category: 'VENUE_CHANGED',
          priority: 'HIGH',
          title: `${label}: room changed`,
          body: `The class at ${when} is now in ${room}.`,
        });
        break;
      }
      case 'ATTENDANCE_OPENED': {
        const until = typeof payload.closesAt === 'string' ? this.when(new Date(payload.closesAt)) : null;
        await send(classPeople, {
          category: 'ATTENDANCE_OPEN',
          priority: 'HIGH',
          title: `${label}: attendance is open`,
          body: `Check in now with the QR code shown in class${until ? `, until ${until}` : ''}.`,
          data: { actions: ['check-in'] },
        });
        break;
      }
      case 'BEACON_DEGRADED': {
        const room = (await this.roomName(session.classroomId)) ?? 'the room';
        await send(who.lecturer, {
          category: 'BEACON_FAULT',
          priority: 'HIGH',
          title: `${label}: classroom beacon not detected`,
          body: `Students' phones in ${room} cannot detect the classroom beacon during your class at ${when}. Their check-ins will wait for your approval. An administrator has been told.`,
        });
        await send(who.admins, {
          category: 'BEACON_FAULT',
          priority: 'HIGH',
          title: `Beacon in ${room} may not be working`,
          body: `During ${label} at ${when}, several phones on site heard nothing from the room's beacon. It is marked "suspected faulty"; please check it on the Beacons page.`,
          data: { path: '/beacons' },
        });
        break;
      }
      case 'AUTO_ENDED':
        await send(who.lecturer, {
          category: 'CLASS_AUTO_ENDED',
          title: `${label} was ended automatically`,
          body: `Your class at ${when} was still running 30 minutes after its scheduled end, so it was ended.`,
        });
        break;
      default:
        break;
    }
  }

  /** Administrators are told about new requests; the lecturer about the decision. */
  async rescheduleAlert(requestId: string, kind: 'created' | 'decided'): Promise<void> {
    const request = await this.prisma.rescheduleRequest.findUnique({ where: { id: requestId } });
    if (!request || request.isDirect) return;
    const session = await this.prisma.classSession.findUniqueOrThrow({
      where: { id: request.classSessionId },
      include: { sections: true },
    });
    const label = await this.label(session);
    const who = await this.audience(session);
    const proposed = this.when(request.proposedStart);
    const base = {
      related: { type: 'reschedule_request', id: request.id },
      dedupeKey: `reschedule:${request.id}:${kind}`,
    };
    if (kind === 'created') {
      await this.notifications.notify({
        ...base,
        userIds: who.admins,
        category: 'RESCHEDULE_REQUESTED',
        title: `${label}: reschedule requested`,
        body: `The lecturer asks to move the class at ${this.when(session.scheduledStart)} to ${proposed}. Reason: ${request.reason}`,
        data: { path: '/reschedule-requests' },
      });
      return;
    }
    await this.notifications.notify({
      ...base,
      userIds: [request.requestedById],
      category: 'RESCHEDULE_DECIDED',
      title: `${label}: reschedule ${request.status.toLowerCase()}`,
      body: `Your request to move the class to ${proposed} was ${request.status.toLowerCase()}.${request.decisionNote ? ` Note: ${request.decisionNote}` : ''}`,
      data: { path: '/reschedule-requests' },
    });
  }

  /** Everyone connected to a class: enrolled students (reps apart), reps, the lecturer, responsible admins. */
  private async audience(session: Session) {
    const sectionIds = session.sections.map((s) => s.sectionId);
    const [enrolled, repStudentIds, lecturer, sections] = await Promise.all([
      this.enrollments.enrolledBySection(sectionIds),
      this.reps.activeRepStudentIds(sectionIds),
      this.lecturers.facts([session.lecturerId]),
      this.courses.sectionSummaries(sectionIds),
    ]);
    const studentIds = [...new Set([...enrolled.values()].flat())];
    const profiles = await this.students.summaries([...studentIds, ...repStudentIds]);
    const userOf = (ids: string[]) =>
      ids.map((id) => profiles.get(id)?.userId).filter((u): u is string => !!u);
    const reps = new Set(userOf(repStudentIds));
    const admins = new Set<string>();
    for (const s of sections.values()) {
      for (const id of await this.scopes.holdersCovering('UNIVERSITY_ADMIN', s.department)) admins.add(id);
    }
    const lecturerUser = lecturer.get(session.lecturerId)?.userId;
    return {
      students: userOf(studentIds).filter((u) => !reps.has(u)),
      reps: [...reps],
      lecturer: lecturerUser ? [lecturerUser] : [],
      admins: [...admins],
    };
  }

  private async label(session: Session) {
    const sections = await this.courses.sectionSummaries(session.sections.map((s) => s.sectionId));
    return [...sections.values()].map((s) => `${s.course.code} ${s.code}`).join(', ') || 'Class';
  }

  private when(at: Date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: this.config.institutionTimezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  }

  private async roomName(classroomId: unknown) {
    if (typeof classroomId !== 'string') return null;
    const room = (await this.places.classroomFacts([classroomId])).get(classroomId);
    return room ? `${room.code} (${room.name})` : null;
  }

  private reasons(payload: Record<string, unknown>) {
    return Array.isArray(payload.reasons) ? payload.reasons.join(' ') : '';
  }
}
