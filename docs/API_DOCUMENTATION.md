# API design

AttendSure exposes one versioned REST API at `/api/v1` and one Socket.IO namespace for live updates. Every route names the permission it needs, and the server checks that permission and the user's scope on every request (ROLE_PERMISSION_MATRIX.md).

**Status:** design draft (2026-11-08). From Phase 1, the exact request and response shapes are generated as OpenAPI from the shared Zod schemas and published at `/api/docs` in development builds. This page then becomes the guide, and the generated reference the contract.

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Format | JSON over HTTPS. Field names in camelCase. Times are ISO 8601 in UTC (`2026-11-10T10:00:00.000Z`). |
| Authentication | `Authorization: Bearer <access token>`. Access tokens last 15 min. The web dashboard keeps its refresh token in an httpOnly cookie; the mobile app keeps it in secure storage. |
| Validation | Every body, query and parameter is validated with the shared Zod schema. Unknown fields are rejected, not ignored. |
| Errors | RFC 9457 problem details: `{ type, title, status, detail, code, requestId, errors? }`. `code` is a stable string such as `QR_EXPIRED` or `CLASS_STATUS_CONFLICT`. |
| Pagination | Cursor based: `?limit=50&cursor=<opaque>`, with a response of `{ data, nextCursor }`. The maximum limit is 200. |
| Idempotency | `Idempotency-Key` header (a UUID) is **required** on `POST /check-ins` and accepted on all other POSTs. A repeated key returns the original response. |
| Concurrency | Editable resources return a `version`. Updates send `If-Match: <version>`. A stale version gets `409` with the current data. |
| Rate limits | Per IP and per user, held in Redis. Sign-in, password reset, check-in and course-rep messages have tighter limits. A blocked request gets `429` with `Retry-After`. |
| Time | Responses carry `serverTime`, so apps can display times without trusting the phone's clock. |

## 2. Endpoints

`Who` uses the role codes SA (Super Admin), UA (University Administrator), RG (Registrar), LE (Lecturer), ST (Student) and CR (Course Rep). Scope rules apply to every row.

### Authentication and account

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/login` | Anyone | `{ email, password, client: WEB|MOBILE, role? }`. Returns tokens, or `{ mfaRequired, enrollmentRequired, mfaToken }` for staff roles. Signing in with a Student or Staff ID number arrives with those records in Phase 2. **Built.** |
| POST | `/auth/mfa/enroll` | Staff, first sign-in | `{ mfaToken }` → `{ secret, otpauthUri }` for the authenticator app. **Built.** |
| POST | `/auth/mfa/verify` | Staff | `{ mfaToken, code }` or `{ mfaToken, recoveryCode }`. On first enrolment the response also carries 10 recovery codes, shown once. 5 wrong codes end the attempt. **Built.** |
| POST | `/auth/refresh` | Signed in | Mobile: `{ refreshToken }`. Web: the `as_refresh` cookie, accepted only with the dashboard's `Origin`. Rotates the token; reusing an old one revokes the session. **Built.** |
| POST | `/auth/logout` | Signed in | Revokes the current session. **Built.** |
| POST | `/auth/activate` | New user | Sets the first password from an activation link. **Built.** |
| POST | `/auth/password/forgot` · `/auth/password/reset` | Anyone | Same response whether or not the account exists. **Built.** |
| POST | `/auth/password/change` | Signed in | Revokes other sessions. **Built.** |
| GET | `/auth/me` | Signed in | User, roles, active role, permission keys. **Built.** |
| POST | `/auth/switch-role` | Multi-role users | Issues a new access token for another held role |
| GET · DELETE | `/me/sessions` · `/me/sessions/:id` | Signed in | See and revoke own sessions |

### Users, roles, settings, audit

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST | `/users` | SA (UA where configured) | List and create staff accounts |
| GET · PATCH | `/users/:id` | SA | View and edit |
| POST | `/users/:id/suspend` · `/users/:id/restore` | SA (UA where configured) | Reason required |
| POST · DELETE | `/users/:id/roles` · `/users/:id/roles/:grantId` | SA | Grant (with scope) and revoke |
| GET · PUT | `/roles` · `/roles/:id/permissions` | SA | View roles; edit unprotected permissions |
| GET · PUT | `/settings` · `/settings/:key` | SA | Institution settings, versioned |
| GET | `/audit-logs` | SA, UA (scoped) | Filter by actor, entity, action, date |

### Academic structure

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST · PATCH | `/faculties`, `/departments`, `/programmes`, `/academic-levels` | SA (UA where configured); read: RG | Structure |
| GET · POST · PATCH | `/academic-years`, `/semesters`, `/calendar-exceptions` | SA (UA where configured) | Periods and holidays |
| POST | `/semesters/:id/activate` · `/semesters/:id/close` | SA | One active semester at a time |
| GET · POST · PATCH | `/courses`, `/course-offerings`, `/course-sections` | SA, UA | Courses and class groups |
| POST · DELETE | `/course-sections/:id/lecturers` · `…/lecturers/:assignmentId` | SA, UA | Lecturer assignments |
| POST · DELETE | `/course-sections/:id/course-reps` · `…/course-reps/:assignmentId` | SA, UA (LE may nominate) | Rep assignments |
| GET · POST · PATCH | `/lecturers`, `/lecturers/:id` | SA (UA where configured) | Lecturer accounts and profiles |

### Students, imports, enrolments

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST | `/students` | SA, RG | Search, filter, register one student |
| GET · PATCH | `/students/:id` | SA, RG | Full record and edits (version-checked) |
| POST | `/students/:id/status` | SA, RG | Change academic status, with reason |
| POST | `/students/:id/photo` | SA, RG | Upload a profile photo (via presigned upload) |
| GET | `/imports/templates/:type?format=csv\|xlsx` | SA, RG | Download a template with the required columns |
| POST | `/imports` | SA, RG | Upload a file, which starts validation |
| GET | `/imports` · `/imports/:id` | SA, RG | History; progress and counts |
| GET | `/imports/:id/rows?status=INVALID` | SA, RG | Preview rows with their errors |
| POST | `/imports/:id/confirm` · `/imports/:id/cancel` | SA, RG | Save valid rows, or discard |
| GET | `/imports/:id/error-report?format=csv\|xlsx` | SA, RG | Failed rows with reasons |
| POST · DELETE | `/enrollments` · `/enrollments/:id` | SA, RG | Enrol, or drop (with reason) |
| POST | `/enrollments/bulk` | SA, RG | Through the import pipeline |

### Places, beacons, devices

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST · PATCH | `/campuses`, `/buildings`, `/classrooms` | SA, UA | Places and geofences |
| GET · POST · PATCH | `/beacons` | SA (UA where configured) | Register and configure beacons |
| GET | `/beacons/:id/health` | SA, UA; LE during own class | Health history |
| POST | `/beacons/:id/calibration` · `/beacons/:id/retire` | SA | Record a site survey; retire |
| POST | `/devices/register` | Signed-in mobile user | Register this phone |
| GET | `/me/devices` | Signed in | Own devices |
| POST | `/me/devices/replacement-requests` | ST | Ask to trust a new phone |
| GET · POST | `/devices?status=PENDING_APPROVAL` · `/devices/:id/approve` · `/devices/:id/revoke` | SA, RG/UA where configured | Approve or revoke |

### Timetables and class sessions

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST · GET | `/timetables` · `/timetables/:id` | SA, UA | Create a draft version; view it |
| POST · PATCH · DELETE | `/timetables/:id/entries` · `/timetable-entries/:id` | SA, UA | Add, edit, cancel entries |
| GET | `/timetables/:id/conflicts` | SA, UA | Room, lecturer, section and student clashes |
| POST | `/timetables/:id/publish` | SA, UA | Blocked while hard conflicts remain |
| GET | `/timetables/:id/history` | SA, UA | Change history |
| GET | `/me/timetable?from=&to=` | LE, ST, CR | Own sessions with live status |
| GET | `/class-sessions?from=&to=&status=&sectionId=` | SA, UA, LE (scoped) | Session list and monitor |
| GET | `/class-sessions/:id` · `/class-sessions/:id/events` | Scoped | Details; event history |
| POST | `/class-sessions/:id/confirm` · `/start` · `/end` · `/interrupt` · `/resume` | LE | Lecturer actions |
| POST | `/class-sessions/:id/delay` | LE, UA | `{ minutes, reason }` |
| POST | `/class-sessions/:id/cancel` | LE (before attendance), UA, SA | `{ reasonCode, note }` |
| POST | `/class-sessions/:id/void` | UA, SA | `{ reason }`; voids attendance and keeps history |
| POST | `/class-sessions/:id/suspend` · `/reinstate` | UA, SA | Administrative hold or reinstatement |
| POST | `/class-sessions/:id/reschedule-requests` | LE, UA | Proposed time and room; returns a conflict check |
| POST | `/reschedule-requests/:id/approve` · `/reject` | UA, SA | Creates the replacement session on approval |
| POST | `/class-sessions/:id/issue-reports` | ST, CR, LE | `{ type, note? }` |
| POST | `/class-sessions/:id/makeup-suggestions` | CR, LE | Proposed times |
| GET · POST | `/class-reviews?status=OPEN` · `/class-reviews/:id/decide` | UA, SA | Review queue and decision |

### Attendance

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/class-sessions/:id/attendance/open` | LE | `{ lateAfterMinutes?, closeAfterMinutes? }` |
| POST | `/attendance-sessions/:id/close` · `/extend` · `/reopen` | LE (UA force-close) | Reason required to reopen |
| GET | `/attendance-sessions/:id/roster` | LE, UA, SA (scoped) | Full roster snapshot with `seq` |
| GET | `/attendance-sessions/:id/qr` | LE | Current token. A fallback when the socket is down. |
| POST | `/check-ins` | ST, CR | `Idempotency-Key` header. Body: `{ qrToken, ble: [{ beaconId, rssi, count }], gps?: { lat, lng, accuracyM, mocked? }, bluetoothState, integrityToken?, deviceId, signature, timestamp, nonce }`. Response: `{ attemptId, outcome, recordStatus, reasonCodes, message, retryAllowed }`. |
| GET | `/check-ins/:attemptId` | Owner | Poll the outcome after a reconnect |
| POST | `/attendance-attempts/:id/request-review` | Owner | Turns a retry-allowed rejection into a manual review |
| POST | `/attendance-attempts/:id/review` | LE, UA | `{ decision: APPROVE \| REJECT, note? }` |
| POST | `/attendance-sessions/:id/attempts/bulk-approve` | LE | Degraded mode only |
| POST | `/attendance-sessions/:id/assisted-check-ins` | LE | `{ studentId, method, reason }` |
| GET | `/attendance-records?sectionId=&studentId=&from=&to=` | Scoped staff | Records |
| POST | `/attendance-records/:id/corrections` | LE, UA, SA | `If-Match`; `{ toStatus, reason }` |
| GET | `/me/attendance` · `/me/attendance/offerings/:id` | ST, CR | Summary and per-course detail |

### Disputes, excuses, files

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST · GET | `/disputes` | ST (own); LE, UA (to review) | Submit and list |
| POST | `/disputes/:id/request-info` · `/respond` · `/approve` · `/reject` · `/withdraw` | By role | Workflow steps |
| POST · GET | `/excuse-requests` | ST (own); LE, UA (to review) | Submit and list |
| POST | `/excuse-requests/:id/request-info` · `/respond` · `/approve` · `/reject` · `/withdraw` | By role | Workflow steps |
| POST | `/files/presign` · `/files/:id/complete` | Signed in | Upload directly to storage; the file type is checked after upload |

### Notifications and announcements

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/me/notifications?unread=` | Signed in | Notification centre |
| POST | `/me/notifications/:id/read` · `/me/notifications/read-all` | Signed in | Mark as read (never counts as attendance) |
| GET · PUT | `/me/notification-preferences` | Signed in | Mandatory categories cannot be switched off |
| POST | `/me/push-token` | Mobile | Register or refresh the FCM token |
| POST · GET | `/announcements` | LE, CR, UA, SA (scoped) | Send and list. Rep messages are rate-limited and labelled. |
| GET | `/announcements/:id/stats` | Author, scoped admins | Delivery and read counts |
| POST | `/announcements/:id/report` · `/announcements/:id/hide` | Recipients · moderators | Abuse reporting and moderation |

### Reports, analytics, operations

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/analytics/attendance?groupBy=faculty\|department\|programme\|level\|course\|lecturer` | UA, SA (scoped) | Aggregates |
| GET | `/analytics/classes?metric=cancellations\|delays\|reviews` | UA, SA | Class operations |
| POST | `/reports/exports` | By report type | `{ reportType, params, format }`; queued and logged |
| GET | `/reports/exports/:id` · `/reports/exports/:id/download` | Requester | Status; short-lived download link |
| GET · POST | `/risk-flags` · `/risk-flags/:id/resolve` | UA, SA (scoped) | Review queue |
| GET | `/system/health` · `/system/jobs` · `/system/events` | SA | Health, job failures, alerts |
| GET | `/me/student-id` | ST | Card data plus a rotating `ASID1` token |
| POST | `/student-id/verify` | Staff | `{ token }` → name, photo, programme, status |
| GET | `/health/live` · `/health/ready` | Infrastructure | Liveness and readiness probes |

## 3. Example: a check-in

```http
POST /api/v1/check-ins
Authorization: Bearer eyJ…
Idempotency-Key: 0b7f8c1e-5a7d-4b8e-9c0a-1f2e3d4c5b6a
Content-Type: application/json

{
  "qrToken": "AS1.0193…",
  "ble": [{ "beaconId": "0193…", "rssi": -63, "count": 9 }],
  "gps": { "lat": 5.6, "lng": -0.18, "accuracyM": 42 },
  "bluetoothState": "ON",
  "deviceId": "0193…",
  "timestamp": "2026-11-10T10:06:12.000Z",
  "nonce": "r5Jt…",
  "signature": "…"
}
```

```json
{
  "attemptId": "0193…",
  "outcome": "VERIFIED",
  "recordStatus": "PRESENT",
  "reasonCodes": [],
  "message": "You're checked in for this class.",
  "retryAllowed": false,
  "serverTime": "2026-11-10T10:06:12.418Z"
}
```

The coordinates in the example are illustrative placeholders, not a Knutsford location.

## 4. Realtime (Socket.IO)

Namespace `/realtime`. The client authenticates with its access token in the handshake. Joining a room is checked against the same permissions as REST.

| Room | Who may join | Events (server → client) |
| --- | --- | --- |
| `attendance:<sessionId>` | Assigned lecturer; scoped administrators | `attendance.roster.updated` `{ seq, record }` · `attendance.stats` `{ seq, counts }` · `attendance.alert` `{ seq, flag }` · `attendance.closed` |
| `attendance-qr:<sessionId>` | Assigned lecturer's display screens | `attendance.qr.rotated` `{ token, window, expiresAt }` |
| `beacon:<classroomId>` | Assigned lecturer during class; administrators | `beacon.health` `{ status, lastSeenAt, battery }` |
| `user:<userId>` | That user only | `notification.new` · `class.status.changed` · `checkin.decided` |

Client → server: `subscribe { room }`, `unsubscribe { room }`, `ping`. The server answers `pong { serverTime }`, which drives the "synced 2 s ago" indicator. A `seq` gap means the client reloads the REST snapshot.
