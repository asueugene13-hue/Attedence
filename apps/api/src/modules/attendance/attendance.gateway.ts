import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { IdSchema } from '@attendsure/shared';
import type { Namespace, Socket } from 'socket.io';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import type { AccessClaims } from '../auth/token.service.js';
import { AttendanceEventsService, rosterRoom } from './attendance-events.service.js';
import { AttendanceSessionsService } from './attendance-sessions.service.js';

type AuthedSocket = Socket & { data: { claims?: AccessClaims } };

/**
 * The live roster connection (namespace `/attendance`). A screen connects with its access token
 * (`auth: { token }`), then joins one attendance session; it is let in only if it may read that roster
 * (the class's lecturer, or an administrator in scope), the same rule as the roster endpoint.
 */
@WebSocketGateway({ namespace: '/attendance' })
export class AttendanceGateway implements OnGatewayInit {
  private readonly logger = new Logger(AttendanceGateway.name);

  constructor(
    private readonly guard: AccessTokenGuard,
    private readonly sessions: AttendanceSessionsService,
    private readonly events: AttendanceEventsService,
  ) {}

  /**
   * Every connection is signed in before it is accepted (middleware runs before "connect"), with the
   * same rules as HTTP requests. A missing or expired token never connects: the client gets a
   * `connect_error` with `data.code = SIGN_IN_AGAIN`.
   */
  afterInit(namespace: Namespace): void {
    this.events.attach(namespace);
    namespace.use((socket: AuthedSocket, next) => {
      const token: unknown = socket.handshake.auth?.token;
      const refuse = () =>
        next(Object.assign(new Error('Sign in again.'), { data: { code: 'SIGN_IN_AGAIN' } }));
      if (typeof token !== 'string') return refuse();
      this.guard
        .claimsFor(token)
        .then((claims) => {
          if (!claims) return refuse();
          socket.data.claims = claims;
          next();
        })
        .catch((error: unknown) => {
          this.logger.error(`Live connection sign-in failed: ${String(error)}`);
          refuse();
        });
    });
  }

  /** `{ attendanceSessionId }` → `{ ok: true, seq }` or `{ ok: false, code }`. */
  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: unknown) {
    const claims = socket.data.claims;
    const parsed = IdSchema.safeParse(
      (body as { attendanceSessionId?: unknown } | null)?.attendanceSessionId,
    );
    if (!claims) return { ok: false, code: 'SIGN_IN_AGAIN' };
    if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
    try {
      await this.sessions.authorize(claims, parsed.data, 'attendance.roster_read', 'attendance.roster_read');
    } catch (error) {
      const code = (error as { response?: { code?: string } }).response?.code ?? 'FORBIDDEN';
      if (!['NOT_YOUR_CLASS', 'PERMISSION_DENIED', 'NOT_FOUND', 'OUT_OF_SCOPE'].includes(code)) {
        this.logger.error(`Roster join failed: ${String(error)}`);
      }
      return { ok: false, code };
    }
    await socket.join(rosterRoom(parsed.data));
    return { ok: true, seq: await this.events.currentSeq(parsed.data) };
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() socket: AuthedSocket, @MessageBody() body: unknown) {
    const parsed = IdSchema.safeParse(
      (body as { attendanceSessionId?: unknown } | null)?.attendanceSessionId,
    );
    if (parsed.success) await socket.leave(rosterRoom(parsed.data));
    return { ok: true };
  }
}
