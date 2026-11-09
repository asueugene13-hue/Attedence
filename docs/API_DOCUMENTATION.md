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
| POST | `/auth/login` | Anyone | `{ email or identifier, password, client: WEB|MOBILE, role? }`. `identifier` may be an email, an 8-digit Student ID or a lecturer staff number; send exactly one of `email` and `identifier`. Returns tokens, or `{ mfaRequired, enrollmentRequired, mfaToken }` for staff roles. An unknown ID gets the same `INVALID_CREDENTIALS` answer as a wrong password. **Built.** |
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
| GET · POST | `/users` | SA | List (`?q=&status=&role=&limit=&cursor=`) and create staff accounts (`{ email, fullName, phone?, roles: [{ role }], reason? }`; roles limited to Super Admin, University Administrator, Registrar; an activation email is sent and `activationEmailSent` says whether it went). **Built.** |
| GET | `/users/:id` | SA | Account, active roles, full grant history, active session count. Never returns hashes or secrets. **Built.** Editing name and phone comes with Phase 2 profiles. |
| POST | `/users/:id/suspend` · `/users/:id/restore` | SA (UA where configured, never on staff administrators) | `{ reason }`. Suspending ends every session. You cannot suspend yourself or the last active Super Admin. **Built.** |
| POST | `/users/:id/activation-email` · `/users/:id/mfa/reset` | SA | Resend activation; reset another person's two-step sign-in (`{ reason }`). **Built.** |
| POST | `/users/:id/roles` · `/users/:id/roles/:grantId/revoke` | SA | Grant `{ role, scopeType?, scopeId?, reason }`. Only the University Administrator role may be limited to a `FACULTY` or `DEPARTMENT` (`scopeId` must name an active one, else `400 INVALID_SCOPE`); other roles are institution-wide. The same scope fields are accepted in `POST /users` `roles`. Revoke `{ reason }`, which ends sessions acting in that role. **Built.** |
| GET · PUT | `/roles` · `/roles/:key/permissions` | SA | List roles with held and assignable permissions; replace a role's permissions `{ permissions, reason }`, limited to the matrix. The Super Admin role is fixed. **Built.** |
| GET · PUT | `/settings` · `/settings/:key` | SA (`settings.manage`) | GET lists every setting with its value, default, `isDefault`, `version`, label and description. PUT `{ value, reason }` with `If-Match: <version>` (0 while it is the default). Values are checked against the catalogue in `packages/shared/src/settings.ts`; the review time must stay later than the unconfirmed time (`400 INCONSISTENT_SETTINGS`); a stale version gets `409 VERSION_CONFLICT`. Audited. First settings: the D-13 monitoring values. **Built.** |
| GET · POST | `/system-events?unacknowledged=&limit=&cursor=` · `/system-events/:id/acknowledge` | `system_health.read` (SA, UA) | Problems the system raised for staff, such as a background job that failed its last try (`job.dead`) or an outbox row that could not be queued (`outbox.stuck`). Acknowledging records who and when, once. **Built.** |
| GET | `/audit-logs` | SA, UA (institution-wide scope) | `?action=<prefix>&entityType=&entityId=&actorUserId=&from=&to=&limit=&cursor=`, newest first. Each search is itself audited. **Built.** |

### Academic structure

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST · PATCH | `/faculties`, `/departments`, `/programmes`, `/academic-levels` | Read: SA, UA, RG (`academic_structure.read`). Change: SA; UA where the Super Admin switches on `academic_structure.manage`, with faculties and levels needing university-wide scope and departments and programmes allowed inside the administrator's faculty or department. | Codes are stored in capitals and unique. `?includeInactive=true`, `?facultyId=`, `?departmentId=`. Deactivate with `PATCH { isActive: false }` (refused while active children exist); nothing is deleted. **Built.** |
| GET · POST · PATCH | `/academic-years`, `/semesters` | Read: as above. Change: university-wide scope with `academic_periods.manage` | Dates are `YYYY-MM-DD`. Years and semesters cannot overlap; semesters stay inside their year; dates change only while a semester is planned. `POST /academic-years/:id/make-current`. **Built.** |
| GET · POST | `/calendar-exceptions` (`?semesterId=&from=&to=`) · `POST /calendar-exceptions/:id/remove { reason }` | As above | Holidays, closures and exam periods; no classes are generated on them (Phase 3). Only entries that have not started can be removed. **Built.** |
| POST | `/semesters/:id/activate` · `/semesters/:id/close` | University-wide scope | One active semester at a time; activating also makes its academic year current. **Built.** |
| GET · POST · PATCH | `/courses`, `/course-offerings` (GET, POST), `/course-sections` (POST, PATCH) | Read: `academic_structure.read`. Change: `courses.manage` within the department or faculty scope of the course | Offerings move DRAFT → OPEN → CLOSED (`POST /course-offerings/:id/open`, `/close`); one per course per semester; not in a closed semester. A course with an open offering cannot be deactivated; a closed offering cannot gain or change sections. Sections may carry a programme and level hint. **Built.** |
| POST | `/course-sections/:id/lecturers` `{ lecturerId, isPrimary? }` · `/course-sections/:id/lecturers/:assignmentId/end { reason }` | `lecturer_assignments.manage` within scope | At most one primary lecturer per section; assistants allowed; ended assignments are kept for history. `GET /me/teaching` (any signed-in user) lists the caller's own current sections. **Built.** |
| GET · POST | `/course-sections/:id/course-reps` | GET: administrators within scope, or a lecturer of the section. POST: `course_reps.assign` within the department or faculty scope of the course | Appoint `{ studentId, reason? }` directly (D-12). The student must be enrolled in the section (`409 NOT_ENROLLED`); one open nomination or appointment per student and section (`409 ALREADY_REP`); not in a closed offering or semester. **Built.** |
| POST | `/course-sections/:id/course-rep-nominations` | LE (`course_reps.nominate`), for sections they teach (`403 NOT_YOUR_SECTION`) | `{ studentId, note? }`. Creates a NOMINATED entry; nothing changes until an administrator decides. **Built.** |
| POST | `/course-reps/:id/approve` · `/reject` · `/end` | `course_reps.assign` within scope | Approve a nomination (re-checks enrolment), reject it `{ reason }`, or end an active appointment `{ reason }`. Each works only from the right status (`409 WRONG_STATUS`). Dropping the student's enrolment ends their rep role for that section automatically. **Built.** |
| GET | `/me/course-reps` | Signed in | The caller's active rep roles; one counts only while its semester is open. Reps keep their Student role; rep tools arrive from Phase 3. **Built.** |
| GET · POST · PATCH | `/lecturers`, `/lecturers/:id` | Read: `academic_structure.read`. Change: `lecturers.manage` within scope | Creating a lecturer for a new email makes a pending account with the Lecturer role and sends an activation email; for an existing account it adds the profile and role instead. Staff numbers are stored in capitals and unique (format pending D-14). **Built.** |

### Students, imports, enrolments

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST | `/students` | SA, RG (`students.read_full`, `students.create`) | List `?q=&facultyId=&departmentId=&programmeId=&levelId=&status=&limit=&cursor=`. Register `{ studentNumber, fullName, email, phone, programmeId, departmentId?, facultyId?, levelId, academicYearId, semesterId, status? }`: the Student ID is exactly 8 digits (D-14), the phone a Ghana number; department and faculty are taken from the programme and, if sent, must match it (`PLACEMENT_MISMATCH`); the semester must belong to the year and not be closed. A new email gets a pending account with the Student role and an activation email; an existing staff account gains the Student role and profile instead. `409 STUDENT_NUMBER_IN_USE`, `409 ALREADY_STUDENT`. **Built.** |
| GET · PATCH | `/students/:id` | SA, RG (`students.update` to edit) | Full record. Edits `{ fullName?, phone?, programmeId?, levelId?, academicYearId?, semesterId?, noDeviceExemption? }` need an `If-Match: <version>` header (`400 VERSION_REQUIRED` without it, `409 VERSION_CONFLICT` with `currentVersion` when someone else changed it first). **Built.** |
| POST | `/students/:id/status` · `/students/:id/verify` | SA, RG | `{ status, reason }` (ACTIVE, DEFERRED, SUSPENDED, WITHDRAWN, GRADUATED…), and Registrar verification of the record. Both need `If-Match` and are audited. **Built.** |
| GET | `/me/student` | Signed in | The caller's own student record, or `{ student: null }`. **Built.** |
| POST · DELETE · GET | `/students/:id/photo` | SA, RG | Upload: multipart field `photo`, JPEG or PNG up to 2 MB, type checked from the bytes (`400 UNSUPPORTED_FILE_TYPE`; `413` when too large); `If-Match` required. Remove: `{ reason }` with `If-Match`. GET returns `{ url, expiresAt, mimeType, sizeBytes }`, a private download link valid for 5 minutes. The student view shows `hasPhoto`. **Built.** |
| GET | `/me/student/photo` | Signed-in student | A 5-minute link to the caller's own photo. **Built.** |

Imports have one address per type, `/imports/<type>` with `<type>` = `students` (needs `students.import`) or `enrollments` (needs `enrollments.manage`), so each is guarded by its own permission. A batch is reachable only through its own type's address.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/imports/<type>/template?format=csv\|xlsx` | SA, RG | The template header row. Students: `student_number, full_name, email, phone, programme_code, level_code, academic_year, semester_number, status` (status optional). Enrolments: `student_number, course_code, academic_year, semester_number, section_code`. Codes and labels are the ones staff entered. **Built.** |
| POST | `/imports/<type>` | SA, RG | Multipart field `file`: CSV or .xlsx, up to 5 MB and 5,000 rows. Every row is checked straight away with the same rules as the single-record endpoint, plus duplicates within the file (all copies held back) and against existing records. Enrolment imports also check section capacity in file order. Returns the batch with counts and status `VALIDATED`; nothing is saved yet. Whole-file problems: `UNSUPPORTED_FILE_TYPE`, `UNREADABLE_FILE`, `COLUMNS_DO_NOT_MATCH` (`errors.missing`, `errors.unknown`), `EMPTY_FILE`, `TOO_MANY_ROWS`. **Built.** |
| GET | `/imports/<type>` · `/imports/<type>/:id` | SA, RG | History (`?status=&limit=&cursor=`); one batch with counts and `activationEmails { pending, sent, failed }`. **Built.** |
| GET | `/imports/<type>/:id/rows?status=&limit=&after=` | SA, RG | Preview rows in order, each with its original values and `errors [{ column, code, message }]`. Page with `after` = the last row number shown. **Built.** |
| POST | `/imports/<type>/:id/confirm` · `/cancel` | SA, RG | Confirm re-checks every row against current records, then saves all valid rows in one transaction (all or none). Rows that became duplicates meanwhile are skipped and marked. Cancel deletes the stored file. Either works once (`409 NOT_PENDING`). **Built.** |
| POST | `/imports/students/:id/activation-emails` | SA, RG | Student imports only: activation emails go out in the background after confirmation, each row recording SENT or FAILED; this re-sends the failed ones. **Built.** |
| GET | `/imports/<type>/:id/error-report?format=csv\|xlsx` | SA, RG | Rows not imported, with `row_number` and `problems` columns. Cells starting with `= + - @` are prefixed with `'` so spreadsheets do not run them as formulas. The fixed report can be uploaded again as it is. **Built.** |

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST | `/enrollments` | SA, RG (`enrollments.manage`) | List `?sectionId=&offeringId=&studentId=&status=&limit=&cursor=`. Enrol `{ studentId, sectionId }`: the student must be ACTIVE (`409 STUDENT_NOT_ACTIVE`), the section active and its offering and semester not closed (`409 OFFERING_CLOSED`); one active enrolment per student per offering (`409 ALREADY_ENROLLED`); section capacity is enforced under a row lock (`409 SECTION_FULL`). The enrolment time is the server's. **Built.** |
| GET | `/enrollments/:id` | SA, RG | One enrolment with student, course, section and semester. **Built.** |
| POST | `/enrollments/:id/end` | SA, RG | `{ status: DROPPED\|WITHDRAWN, reason }`. The record is kept; the student can be enrolled again later. Ends any course-rep role or nomination the student holds for that section. **Built.** |
| GET | `/course-sections/:id/students` | Enrolment staff; a lecturer teaching the section; or a course-rep administrator (`course_reps.assign`) within their faculty or department scope, to choose a rep | The section's current roster with Student ID, name, programme and level. **Built.** |
| GET | `/me/enrollments` | Signed in | The caller's own enrolments (empty for non-students). **Built.** |

### Places, beacons, devices

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST · PATCH | `/campuses`, `/buildings`, `/classrooms` | Read: every role (`timetables.read`; room names are not sensitive). Change: `classrooms.manage` with university-wide scope | Geofence `{ lat, lng, radiusM }` (20–5,000 m) on a campus or a building; `null` clears it. A building's geofence overrides its campus's. `GET /classrooms` returns each room's building, campus and effective geofence; filters `?campusId=&buildingId=&minCapacity=&includeInactive=`. Codes are unique within the parent. Deactivate, never delete. **Built.** |
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
