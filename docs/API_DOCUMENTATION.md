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
| GET | `/verification-policies/current` · `/verification-policies` | `verification_policies.manage` (SA; UA where switched on) | The policy in force (version 0 = the defaults in PRESENCE_VERIFICATION.md §9), and every version newest first. **Built (Phase 4 step 2).** |
| POST | `/verification-policies` | Same | `{ rules, reason }`: a new version (rules not given take their defaults; each is range-checked). Versions are never edited (database trigger). Turning `bleRequired` off needs a Super Admin (`403 SUPER_ADMIN_REQUIRED`). Audited. **Built.** |
| POST | `/verification-policies/try` | Same | `{ ble, gps, device?, integrity?, sharedDeviceInSession?, degradedMode?, retryRejectionsSoFar? }`: what the current policy would decide, with the student message, flags and the full rule trace. Nothing is saved. **Built.** |
| GET · POST | `/system-events?unacknowledged=&limit=&cursor=` · `/system-events/:id/acknowledge` | `system_health.read` (SA, UA) | Problems the system raised for staff, such as a background job that failed its last try (`job.dead`) or an outbox row that could not be queued (`outbox.stuck`). Acknowledging records who and when, once. **Built.** |
| GET | `/audit-logs` | SA, UA (institution-wide scope) | `?action=<prefix>&entityType=&entityId=&actorUserId=&from=&to=&limit=&cursor=`, newest first. Each search is itself audited. **Built.** |

### Academic structure

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST · PATCH | `/faculties`, `/departments`, `/programmes`, `/academic-levels` | Read: SA, UA, RG (`academic_structure.read`). Change: SA; UA where the Super Admin switches on `academic_structure.manage`, with faculties and levels needing university-wide scope and departments and programmes allowed inside the administrator's faculty or department. | Codes are stored in capitals and unique. `?includeInactive=true`, `?facultyId=`, `?departmentId=`. Deactivate with `PATCH { isActive: false }` (refused while active children exist); nothing is deleted. **Built.** |
| GET · POST · PATCH | `/academic-years`, `/semesters` | Read: as above. Change: university-wide scope with `academic_periods.manage` | Dates are `YYYY-MM-DD`. Years and semesters cannot overlap; semesters stay inside their year; dates change only while a semester is planned. `POST /academic-years/:id/make-current`. **Built.** |
| GET · POST | `/calendar-exceptions` (`?semesterId=&from=&to=`) · `POST /calendar-exceptions/:id/remove { reason }` | As above | Holidays, closures and exam periods; no classes are generated on them (Phase 3). Only entries that have not started can be removed. Adding or removing one that stops classes cancels or restores the affected classes of published timetables in the background (Phase 3 step 4b; CLASS_LIFECYCLE.md §2). **Built.** |
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

**Signed requests (Phase 4 step 1).** Requests that must come from the student's own phone carry four headers: `x-device-id`, `x-device-timestamp` (milliseconds), `x-device-nonce` (single use) and `x-device-signature` (Ed25519, base64url). The signed text is `deviceSigningPayload` in `packages/shared/src/devices.ts`: a fixed label, the method, the full path with query, the time, the nonce and the SHA-256 of the exact body bytes. Refusals: `401 DEVICE_SIGNATURE_REQUIRED`, `DEVICE_SIGNATURE_INVALID`, `DEVICE_UNKNOWN` (not the caller's phone), `DEVICE_CLOCK_SKEW` (more than 5 minutes off), `DEVICE_SIGNATURE_REPLAYED`; `403 DEVICE_REVOKED`.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST · PATCH | `/campuses`, `/buildings`, `/classrooms` | Read: every role (`timetables.read`; room names are not sensitive). Change: `classrooms.manage` with university-wide scope | Geofence `{ lat, lng, radiusM }` (20–5,000 m) on a campus or a building; `null` clears it. A building's geofence overrides its campus's. `GET /classrooms` returns each room's building, campus and effective geofence; filters `?campusId=&buildingId=&minCapacity=&includeInactive=`. Codes are unique within the parent. Deactivate, never delete. **Built.** |
| GET | `/beacons?classroomId=&status=` · `/beacons/:id` | `beacon_health.read` (SA, UA, LE) | Beacons with room, protocol, identifier, threshold, status and battery. Keys are never returned (`hasRotationKey` only). **Built (Phase 4 step 3).** |
| POST · PATCH | `/beacons` · `/beacons/:id` | `beacons.manage` with university-wide scope | Create `{ classroomId, label, protocol, identifier, rotationKey?, rotationExponent?, txPowerDbm?, installedOn?, notes? }`: identifiers are checked by protocol and stored lower-case (`409 DUPLICATE_BEACON`); rotating protocols need their 16-byte key (stored encrypted), Eddystone-EID its exponent. PATCH with If-Match: moving room or switching off needs `reason` (`400 REASON_REQUIRED`); moving clears the threshold. Audited without the key. **Built.** |
| GET · POST | `/calibration-surveys?classroomId=` · `/calibration-surveys/:id` · `/calibration-surveys` | `beacons.manage` with university-wide scope | Record `{ classroomId, notes?, measurements: [{ beaconId, phoneModel, platform, position, rssi }] }` (beacons of that room only, `400 BEACON_NOT_IN_ROOM`). The result per beacon: phone models, weakest inside, strongest outside, and the threshold halfway between them, or a problem (`NOT_ENOUGH_PHONES` under 3 models, `NO_INSIDE_READINGS`, `NO_OUTSIDE_READINGS`, `OVERLAP`). **Built.** |
| POST | `/calibration-surveys/:id/measurements` | Same | `{ measurements: [...] }`: another phone's readings, added to a survey not yet applied (each phone can only measure itself). Readings are only added, never changed; the result is recomputed from all of them and audited (`calibration_surveys.measurements_added`). `409 ALREADY_APPLIED` once applied; `400 BEACON_NOT_IN_ROOM`. **Built (Phase 4 step 4).** |
| POST | `/calibration-surveys/:id/apply` | Same | `{ reason? }`: sets each surveyed beacon's threshold, once (`409 ALREADY_APPLIED`). Refused if any beacon has a problem (`409 SURVEY_HAS_PROBLEMS`) or moved room since (`409 BEACON_MOVED`). The survey row is locked, so readings added at the same moment are either included or refused. **Built.** |
| GET | `/me/beacon-scan-list` | Any signed-in user | What the phone listens for: `{ data: [{ id, identifier, protocol, classroomId }], rooms: [{ id, code, name }] }`. Active (or suspected faulty) fixed-ID beacons in rooms in use. Thresholds stay on the server; rotating-ID beacons are left out until D-08 (limitation 57). **Built (Phase 4 step 4).** |
| POST | `/classroom-checks` | Any signed-in user, **signed by the phone** | "Check this classroom": `{ classroomId, bluetooth: ON\|OFF\|DENIED, readings: [{ identifier, rssi }] (≤ 200), location: { latitude, longitude, accuracyM, isMocked? } \| null }` → `{ policyVersion, classroom, evidence: { ble, strongestOwnRssi, roomBeacons, recognisedReadings, gps, distanceM, hasGeofence, device }, decision }`. Runs the real rules with the current policy and this phone's real status; QR, session and enrolment gates are treated as passed (they belong to check-in, Phase 5). Unregistered identifiers are ignored; an uncalibrated beacon is never strong. **Nothing is recorded.** **Built (Phase 4 step 4).** |
| GET | `/beacons/:id/health?hours=24` | `beacon_health.read` (SA, UA, LE) | `{ beacon, lastHeardAt, windows: [{ windowStart, sightings, distinctDevices, medianRssi }] }`, newest first, 1–168 hours. Not yet narrowed to a lecturer's own classes (limitation 66). **Built (Phase 4 step 5).** Reports arrive from check-in (Phase 5) through `BeaconHealthService.recordObservation`; there is no public endpoint for them. |
| POST | `/me/devices` | Signed in (the app, after each sign-in) | `{ installationId, platform: ANDROID|IOS, publicKey, model?, osVersion?, appVersion? }`. Registers this phone or recognises it again. A student's first phone becomes their trusted attendance phone; any later phone is `PENDING_APPROVAL` (D-10). Staff phones are trusted but never attendance phones. The same installation with a different key: `409 DEVICE_KEY_MISMATCH` (the app then starts over as a new phone). **Built (Phase 4 step 1).** |
| GET | `/me/devices` | Signed in | The caller's phones. **Built.** |
| GET | `/me/devices/current` | Signed in, **signed by the phone** | The phone that signed the request, with its status. Proves the phone holds its key. **Built.** |
| POST | `/me/devices/:id/request-trust` | Students (`devices.request_replacement`) | `{ reason }`: make this waiting phone my attendance phone. Three requests within 90 days raise a `DEVICE_SWITCH` flag. **Built.** |
| GET | `/devices?requested=true\|status=&q=` | `devices.approve` with university-wide scope | Requests waiting for a decision (oldest first), or phones by status; `q` searches name, email or Student ID. **Built.** |
| POST | `/devices/:id/approve` · `/devices/:id/revoke` | Same | Approve `{ note? }`: the phone becomes the attendance phone and the old one `REPLACED`. Revoke `{ reason }`: refuse a waiting phone, or revoke a trusted one (lost or stolen); a revoked student's next phone still needs approval. Audited. **Built.** |

### Timetables and class sessions

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET · POST | `/timetables?semesterId=&status=` · `/timetables` | Read: `timetables.read` (every role). Create: `timetables.manage` with university-wide scope | Create `{ semesterId, name }`: one draft per semester (`409 DRAFT_EXISTS`); when a published timetable exists, the draft starts as a copy of it. Not in a closed semester. **Built.** |
| GET | `/timetables/:id` | `timetables.read` | The timetable, its semester, and its entries with sections, lecturer, room, times (HH:MM, Africa/Accra), recurrence and exceptions. **Built.** |
| POST · PATCH | `/timetables/:id/entries` · `/timetable-entries/:id` | `timetables.manage`, within the scope of every section in the entry | `{ sectionIds, lecturerId, classroomId, recurrence: WEEKLY\|EVERY_OTHER_WEEK\|SELECTED_WEEKS\|ONCE, dayOfWeek (1 = Mon), date (ONCE), startTime, endTime, effectiveFrom?, effectiveTo?, selectedWeeks? }`. Dates default to the semester's. The lecturer must teach every section (`LECTURER_NOT_ASSIGNED`); sections must be in this semester's open offerings; the room must be active; dates inside the semester (`OUTSIDE_SEMESTER`); at least one meeting (`NO_MEETINGS`). PATCH replaces the entry and needs `If-Match`. Drafts only (`409 NOT_DRAFT`) until step 4. **Built.** |
| POST | `/timetable-entries/:id/cancel` · `/timetable-entries/:id/exceptions` · `…/exceptions/:exceptionId/remove` | `timetables.manage` within scope | Cancel `{ reason }` (kept, marked cancelled). Skip one date `{ date, reason }`; it must be one of the entry's meeting dates. **Built.** |
| GET | `/timetable-entries/:id/dates` | `timetables.read` | `{ dates, skipped: [{ date, why }] }`: when the entry meets, and which dates holidays or exceptions remove. **Built.** |
| GET | `/timetables/:id/conflicts` | `timetables.manage` | `{ blocking, warnings, canPublish }`. Blocking: the same room, lecturer or section at overlapping times on the same date. Warnings: students enrolled in two overlapping sections (with their Student IDs), rooms smaller than the enrolment, inactive rooms, lecturers on leave, dates removed by holidays, entries that never meet. **Built.** |
| POST | `/timetables/:id/publish` | `timetables.publish` with university-wide scope | `{ reason? }`. Refused while blocking clashes remain (`409 HAS_CONFLICTS`, each clash listed) or with no entries. The semester's previous published version becomes SUPERSEDED. **Built.** Class meetings are generated in step 3. |
| GET | `/timetables/:id/history` | `timetables.manage` | Every change, newest first, with who, when, before, after and reason. **Built.** |
| GET | `/me/timetable?from=&to=` | Signed in | The caller's own sessions in the active role: a lecturer's classes, or a student's (and course rep's) enrolled sections. Local dates, at most 62 days; cancelled classes included and marked. `{ as: LECTURER\|STUDENT\|NONE, data }`. **Built.** |
| GET | `/class-sessions?from=&to=&sectionId=&lecturerId=&classroomId=&status=` | `timetables.read` | Sessions between two local dates (inclusive, at most 62 days, `400` otherwise), with sections, lecturer, room, status and cancellation reason. **Built.** Scoped monitoring views come with step 5. |
| GET | `/class-sessions/:id` | `timetables.read` | One session with its full, append-only event history. The lecturer includes `userId`, so the apps can tell the class's own lecturer which buttons apply (the API still checks). **Built.** |
Class actions follow the shared transition table (`packages/shared/src/class-lifecycle.ts`, CLASS_LIFECYCLE.md §4). Each returns the session with its history. A lecturer may act only on classes they teach (`403 NOT_YOUR_CLASS`); administrators only within their faculty or department scope. An action not allowed from the current status gets `409 TRANSITION_NOT_ALLOWED`; if someone else changed the class a moment earlier, `409 STATUS_CHANGED`. Every action writes a class event and an audit entry. **Built (Phase 3 step 4a).**

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/class-sessions/:id/confirm` · `/start` · `/resume` | The class's lecturer (`class_sessions.start`) | Confirm (from SCHEDULED). Start (from any not-started status, from 15 min before the start until the scheduled end; `409 OUTSIDE_START_WINDOW`). Resume an interrupted class before its scheduled end. **Built.** |
| POST | `/class-sessions/:id/end` · `/interrupt` | The class's lecturer; an administrator for interrupting, or ending an interrupted class | Interrupt needs `{ reason }`. **Built.** |
| POST | `/class-sessions/:id/delay` | Lecturer of the class, or administrator (`class_sessions.delay`) | `{ minutes (5–240), reason }`. The new expected start must leave 30 min before the scheduled end (`409 DELAY_TOO_LONG`: cancel or reschedule instead). **Built.** |
| POST | `/class-sessions/:id/cancel` | Lecturer of the class (before it starts), administrator (also from on hold) (`class_sessions.cancel`) | `{ reasonCode, note? }`. `OTHER` needs a note; `LECTURER_ABSENT_NO_NOTICE` is for administrators only (`403 ADMIN_ONLY_REASON`). **Built.** |
| POST | `/class-sessions/:id/suspend` · `/lift-hold` | Administrator (`class_sessions.suspend`) | `{ reason }`. Put a class that has not started on hold; lift it before the scheduled end. **Built.** |
| POST | `/class-sessions/:id/void` · `/reinstate` | Administrator (`class_sessions.void`) | Void `{ reason, reasonCode? }` a class that started (nothing is deleted; attendance voiding comes in Phase 5). Reinstate `{ reason }` a mistaken cancellation before the scheduled end; never a voided class (`409 CANNOT_REINSTATE_VOIDED`); refused if the room or lecturer has since been booked (`409 SLOT_TAKEN`). **Built.** |
| POST | `/class-sessions/:id/open-review` | Administrator (`class_reviews.decide`) | `{ reason }`: refer a class that has not started to review. Also opens a review record (trigger `ADMIN_OPENED`) for the review queue. Review decisions come with monitoring (step 5). **Built.** |

**Reschedules (D-11). Built (Phase 3 step 4b).** A proposal is `{ date, startTime, endTime, classroomId }` (Africa/Accra wall-clock times, HH:MM). The conflict check returns `blockers` (`IN_THE_PAST`, `ROOM_UNAVAILABLE`, `ROOM_TAKEN`, `LECTURER_BUSY`) and `warnings` (`STUDENT_CLASH` with a count, `NO_CLASS_DAY`, `ROOM_TOO_SMALL`). Any blocker refuses a request, an approval or a direct reschedule with `409 RESCHEDULE_BLOCKED`, the findings in `errors`. Warnings never refuse. Approval runs the check again; if a clash slips in between, the database refuses it (`409 SLOT_TAKEN`). On approval, one transaction creates the replacement session (`kind: REPLACEMENT`, `rescheduledFromId`), sets the original to `RESCHEDULED` through the lifecycle service, and writes class events and audit entries. A lecturer may act only on classes they teach; an administrator only within scope.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/class-sessions/:id/reschedule-check` | The class's lecturer, or an administrator who may decide | The conflict check for a proposal; nothing is saved. |
| POST | `/class-sessions/:id/reschedule-requests` | The class's lecturer (`class_sessions.request_reschedule`) | Proposal plus `reason`. `201` with the request (`PENDING`) and its warnings. One waiting request per class (`409 REQUEST_PENDING`); the class must not have started (`409 TRANSITION_NOT_ALLOWED`). |
| GET | `/reschedule-requests?status=` | Lecturers: their own requests. Administrators with `class_sessions.reschedule`: those for classes within scope | Newest first, with the class, the proposed room and, once approved, the replacement class. |
| GET | `/reschedule-requests/:id` | The requester, or an administrator within scope | While pending, includes a fresh `check`. |
| POST | `/reschedule-requests/:id/approve` | Administrator (`class_sessions.reschedule`) | `{ note? }`. `409 ALREADY_DECIDED` if decided; `409 TRANSITION_NOT_ALLOWED` if the class was cancelled or started meanwhile. |
| POST | `/reschedule-requests/:id/reject` | Administrator (`class_sessions.reschedule`) | `{ note }` (required). |
| POST | `/reschedule-requests/:id/withdraw` | The lecturer who asked | While pending. |
| POST | `/class-sessions/:id/reschedule` | Administrator (`class_sessions.reschedule`) | Direct reschedule in exceptional cases: proposal plus `reason` (required). Recorded as an approved request with `isDirect: true`; a waiting request for the class is closed as rejected. |

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/class-sessions/:id/issue-reports` | Enrolled students, the section's course rep, the class's lecturer (`class_issues.report`) | `{ type, note? (≤ 500) }`. Types: `LECTURER_NOT_ARRIVED`, `VERBAL_CANCELLATION`, `CLASS_DELAYED`, `WRONG_CLASSROOM`, `VENUE_PROBLEM`, `TIMETABLE_ERROR`, `TECHNICAL_PROBLEM`, `OTHER`. Open from 30 min before the (expected) start until the scheduled end ("not arrived" from +5 min); `409 OUTSIDE_REPORT_WINDOW`, `409 CLASS_CLOSED` for completed, cancelled or rescheduled classes. One per person, type and class (`409 DUPLICATE_REPORT`); students at most 3 per class and 10 a day (`409 REPORT_LIMIT`). `403 NOT_IN_CLASS` for students not enrolled. The reporter's role (`STUDENT`, `COURSE_REP`, `LECTURER`) is decided by the server. Each report queues an immediate check of the class. **Built (Phase 3 step 5a).** |
| GET | `/class-sessions/:id/issue-reports` | Signed in | Administrators within scope (`class_reviews.decide`) see every report with the reporter; the class's lecturer sees every report without student identities; anyone else sees only their own. **Built.** |
| POST | `/class-sessions/:id/makeup-suggestions` | CR, LE | Proposed times |
| GET | `/class-reviews?status=OPEN\|DECIDED` | Administrator (`class_reviews.decide`), within scope | Open reviews: priority first, then the oldest. Each with the class, trigger, reasons and report counts by type. **Built (Phase 3 step 5b).** |
| GET | `/class-reviews/:id` | Same | The review with the class's full event timeline and every report (with reporters). **Built.** |
| POST | `/class-reviews/:id/decide` | Same | `{ decision, note }` plus: `CANCELLED` + `reasonCode`; `POSTPONED` + `minutes` from the scheduled start (the new start must be in the future, `409 DELAY_IN_PAST`, and leave 30 min); `RESCHEDULED` + `reschedule: { date, startTime, endTime, classroomId }` (runs the reschedule flow and its conflict check). `CLASS_HELD` (not before the scheduled start) and `NO_ACTION` (only before start + 15 min, `409 TOO_LATE_FOR_NO_ACTION`; returns to CONFIRMED if the lecturer had confirmed). If the lecturer started the class after the review opened, only `CLASS_HELD` is possible (`409 CLASS_STARTED`) and the class is left as it is. `409 ALREADY_DECIDED`. **Built.** |
| POST | `/class-issue-reports/:id/dismiss` | Same | `{ note }`. The report stays in the record but no longer counts as evidence (`409 ALREADY_DISMISSED`). **Built.** |

### Attendance

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/class-sessions/:id/attendance/open` | The class's own lecturer (`attendance.open`) | `{ startClass = true, lateAfterMinutes?, closeAfterMinutes? }` (defaults from the settings `attendance.lateAfterMinutes` 15 and `attendance.closeAfterMinutes` 20, D-09 interim). With `startClass`, a class not yet started is started in the same transaction (the start's timing rules apply); otherwise `409 CLASS_NOT_STARTED`. `lateAfter` = later of the scheduled start and now, plus the late minutes; `closesAt` = now plus the close minutes. `409 ATTENDANCE_ALREADY_OPENED` (once per class), `409 CLASS_OVER` after the scheduled end, `403 NOT_YOUR_CLASS`. Writes `ATTENDANCE_OPENED`, which tells enrolled students and reps ("attendance is open"). **Built (Phase 5 step 1).** |
| GET | `/class-sessions/:id/attendance` · `/attendance-sessions/:id` | The class's lecturer, or SA/UA in scope (`attendance.roster_read`) | `{ id, classSessionId, status, openedAt, lateAfter, closesAt, closedAt, closeReason, reopenedAt, qrRotationSeconds, policyVersion, version, counts: { STATUS: n } }`; the first returns `{ data: … \| null }`. The QR secret is never returned. **Built.** |
| POST | `/attendance-sessions/:id/close` · `/extend` · `/reopen` | Close: the class's lecturer, or SA/UA in scope with `attendance.force_close` and `{ reason }` (`400 REASON_REQUIRED`). Extend, reopen: the class's lecturer | Close marks every student **eligible at the scheduled start** (enrolled by then, not dropped before) without a record ABSENT, safely repeatable; `409 ATTENDANCE_CLOSED` if already closed. Extend `{ minutes 1–60, reason }`, never past the scheduled end + 30 min (`409 TOO_LATE`). Reopen `{ reason, minutes = 10 }` once (`409 ALREADY_REOPENED`), while the class is running and before its scheduled end; never for a voided class. Version-checked (`409 ATTENDANCE_CHANGED`), audited, written to the class history. A sweeper closes sessions every minute when their time is up (`AUTO`) or the class ended (`CLASS_ENDED`), and when a class is **voided** after attendance started, every record becomes VOIDED with a correction row (`CLASS_VOIDED`). **Built (Phase 5 step 1).** |
| GET | `/attendance-sessions/:id/roster` | LE, UA, SA (scoped) | Full roster snapshot with `seq` |
| GET | `/attendance-sessions/:id/qr` | The class's own lecturer (`attendance.open`) | `{ token, window, rotationSeconds, expiresAt, serverTime, closesAt }`: `AS1.<attendanceSessionId>.<window>.<mac>` (PRESENCE_VERIFICATION §2), changing every `qrRotationSeconds` (policy, default 15). `409 ATTENDANCE_CLOSED` once closed. **Built (Phase 5 step 1);** live push comes with the roster (step 3). |
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
| GET | `/me/notifications?unread=&limit=&cursor=` | Signed in | The caller's own notifications, newest first, with `nextCursor`. Each has `category`, `title`, `body`, `priority` and `data` (`path` to open, lecturer `actions`). **Built (Phase 3 step 6).** |
| GET | `/me/notifications/unread-count` | Signed in | `{ unread }`. **Built.** |
| POST | `/me/notifications/:id/read` · `/me/notifications/read-all` | Signed in | Mark as read (never counts as attendance). Another person's notification is `404`. **Built.** |
| GET · PUT | `/me/notification-preferences` | Signed in | Every category with its EMAIL and PUSH switches (`available` is false for push until it is set up). PUT `{ category, channel, enabled }`; mandatory categories (cancelled, rescheduled, back on, room changed) cannot be switched off (`409 MANDATORY_CATEGORY`). **Built.** |
| POST | `/me/push-token` | Mobile | Register or refresh the FCM token. Not built: push waits for a university-owned Firebase project. |
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
| GET · POST | `/risk-flags?status=OPEN\|DISMISSED\|CONFIRMED&type=` · `/risk-flags/:id/review` | `risk_flags.review` (SA, UA) | The review queue (open flags oldest first). Review `{ decision: CONFIRMED|DISMISSED, note }`; a flag never changes attendance or access by itself. `409 ALREADY_REVIEWED`. **Built (Phase 4 step 1).** |
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
