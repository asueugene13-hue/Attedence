import { Injectable, Logger } from '@nestjs/common';
import { ATTENDANCE_EVENT, type AttendanceEventType } from '@attendsure/shared';
import type { Namespace } from 'socket.io';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

export const rosterRoom = (attendanceSessionId: string) => `attendance:${attendanceSessionId}`;
const seqKey = (attendanceSessionId: string) => `attendance:seq:${attendanceSessionId}`;
const SEQ_TTL_SECONDS = 2 * 24 * 3600;

/**
 * Live roster events (ATTENDANCE_FLOW §6). Each change is sent to the screens watching that attendance
 * session with an increasing `seq`; a screen that sees a gap (or reconnects) reloads the roster, so a
 * lost event is never a wrong screen for long. Sent after the change is saved.
 */
@Injectable()
export class AttendanceEventsService {
  private readonly logger = new Logger(AttendanceEventsService.name);
  private namespace: Namespace | null = null;

  constructor(private readonly redis: RedisService) {}

  /** Called by the gateway once the live server exists. */
  attach(namespace: Namespace): void {
    this.namespace = namespace;
  }

  async currentSeq(attendanceSessionId: string): Promise<number> {
    try {
      return Number((await this.redis.client.get(seqKey(attendanceSessionId))) ?? 0);
    } catch (error) {
      this.logger.warn(`Roster seq unavailable: ${String(error)}`);
      return 0;
    }
  }

  async publish(attendanceSessionId: string, type: AttendanceEventType, data: unknown): Promise<void> {
    let seq: number | null = null;
    try {
      const key = seqKey(attendanceSessionId);
      const [[, value]] = (await this.redis.client.multi().incr(key).expire(key, SEQ_TTL_SECONDS).exec()) as [
        [unknown, number],
      ];
      seq = value;
    } catch (error) {
      // Without a number, screens treat the event as a gap and reload: slower, never wrong.
      this.logger.warn(`Roster seq not assigned: ${String(error)}`);
    }
    this.namespace
      ?.to(rosterRoom(attendanceSessionId))
      .emit(ATTENDANCE_EVENT, { seq, type, attendanceSessionId, data });
  }
}
