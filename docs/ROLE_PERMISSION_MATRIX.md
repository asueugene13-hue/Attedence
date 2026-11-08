# Role and permission matrix

Every action in AttendSure needs a named permission. The server checks it on every request, along with whether the target record is inside the user's scope. Hiding a button in the app is never the security.

**Status:** design draft (2026-11-08). Permission keys and role defaults are seeded in Phase 1. The Super Admin can adjust which permissions the University Administrator and Registrar roles hold. Protected permissions cannot be given to any other role.

## Legend

| Code | Meaning |
| --- | --- |
| **Y** | Allowed across the whole university |
| **S** | Allowed within the user's scope (defined below) |
| **O** | Own records only |
| **R** | Can request; someone else approves |
| **C** | Off by default; the Super Admin may switch it on for the role |
| **read** | View only |
| — | Not allowed |

Course Representatives keep every Student permission. Their column shows only what the rep assignment adds.

## Scope

| Role | Scope |
| --- | --- |
| Super Admin | The whole installation |
| University Administrator | The faculties or departments named in the role grant. A grant at institution level covers everything. |
| Registrar | All student records (pending confirmation that Knutsford has one central registry) |
| Lecturer | Sections they are assigned to in the current semester. Past assignments are read-only. |
| Student | Their own records and the sections they are enrolled in |
| Course Representative | The single section in their active assignment, for that semester only |

## Matrix

| Capability | Super Admin | Univ. Admin | Registrar | Lecturer | Student | Course Rep (adds) |
| --- | --- | --- | --- | --- | --- | --- |
| **Accounts and system** | | | | | | |
| Create and manage administrator accounts | Y | — | — | — | — | — |
| Assign and revoke staff roles | Y | — | — | — | — | — |
| Change which permissions a role holds | Y | — | — | — | — | — |
| Suspend or restore accounts | Y | C | — | — | — | — |
| System, notification and security settings | Y | — | — | — | — | — |
| Verification policies and thresholds | Y | C | — | — | — | — |
| Class-monitoring thresholds | Y | C | — | — | — | — |
| View system health | Y | C | — | — | — | — |
| View audit logs | Y | S | — | — | — | — |
| Review security alerts and risk flags | Y | S | — | S read (own sessions) | — | — |
| **Academic structure** | | | | | | |
| Faculties, departments, programmes, levels | Y | C | read | — | — | — |
| Academic years, semesters, holidays and closures | Y | C | read | — | — | — |
| Courses, offerings, sections | Y | S | read | O read | — | — |
| Lecturer accounts and profiles | Y | C | — | O read | — | — |
| Assign lecturers to sections | Y | S | — | O read | — | — |
| Appoint or end course-rep assignments (D-12) | Y | S | — | R (nominate) | — | — |
| **Students** | | | | | | |
| Register a student | Y | — | Y | — | — | — |
| Bulk import students | Y | — | Y | — | — | — |
| Edit student details and academic status | Y | — | Y | — | — | — |
| Manage course enrolments | Y | — | Y | — | — | — |
| View a full student record | Y | — | Y | — | O | — |
| View a section's class list (name, ID, photo, attendance) | Y | S | Y | S | — | — |
| Approve a replacement attendance phone (D-10) | Y | C | C | — | R | — |
| **Places and timetable** | | | | | | |
| Campuses, buildings, classrooms | Y | S | — | — | — | — |
| Register and manage BLE beacons | Y | C | — | — | — | — |
| View beacon health | Y | S | — | S (during own class) | — | — |
| Create, edit and publish timetables | Y | S | — | — | — | — |
| View timetable | Y | S | read | O | O | — |
| **Class operations** | | | | | | |
| Confirm, start and end a class | — | — | — | S | — | — |
| Report a delay | — | S | — | S | — | — |
| Cancel a class before attendance opens | Y | S | — | S | — | — |
| Cancel or void a class after attendance started | Y | S | — | R | — | — |
| Reschedule a class (D-11) | Y | S | — | R | — | — |
| Report a class issue | — | — | — | S | O | — |
| Suggest make-up class times | — | — | — | S | — | S |
| Decide a class under review | Y | S | — | — | — | — |
| Suspend or reinstate class sessions | Y | S | — | — | — | — |
| **Attendance** | | | | | | |
| Open and close attendance, show the QR | — | S (force-close only) | — | S | — | — |
| Check in | — | — | — | — | O | — |
| View the live roster | Y read | S read | — | S | — | — |
| Approve or reject pending check-ins | — | S | — | S | — | — |
| Lecturer-assisted check-in (exception) | — | — | — | S | — | — |
| Correct an attendance record, with reason | Y | S | — | S (within 14 days; later needs approval) | — | — |
| View own attendance and history | — | — | — | — | O | — |
| Edit own attendance | — | — | — | — | — | — |
| Submit a dispute or excuse request | — | — | — | — | O | — |
| Review disputes and excuse requests | Y | S | — | S | — | — |
| **Communication** | | | | | | |
| Send official course announcements | — | S | — | S | — | — |
| Send course-rep updates (rate-limited, labelled) | — | — | — | — | — | S |
| Send institution-wide announcements | Y | Y | — | — | — | — |
| Hide announcements and handle message reports | Y | S | — | S (own courses) | — | — |
| Report an abusive message | Y | Y | Y | Y | Y | — |
| View announcement delivery statistics | Y | S | — | O | — | O |
| **Reports** | | | | | | |
| Course and class attendance reports | Y | S | — | S | — | — |
| Faculty, department, programme, lecturer analytics | Y | S | — | — | — | — |
| Student record and enrolment reports | Y | — | Y | — | — | — |
| Export files containing personal data (always logged) | Y | S | Y | S | — | — |

### What a Course Representative can never do

Course reps cannot mark or edit attendance, cancel official classes, change timetables, register students, view private student records, approve disputes or override lecturer decisions. Their class-issue reports add weight to the evidence in [CLASS_MONITORING.md](CLASS_MONITORING.md), but they never change a class's status by themselves.

### Super Admin safeguards

- At least two Super Admin accounts should exist, and the last one cannot be removed or suspended.
- Two-factor sign-in is required (D-03).
- The Super Admin corrects attendance through the same reason-and-audit workflow as everyone else. There is no silent edit path.
- The Super Admin cannot start classes or check in. Those actions belong to the people physically present.

## Permission keys

Keys follow `domain.action`. Examples: `users.manage_admins`, `roles.assign`, `roles.edit_permissions`, `settings.manage`, `audit_logs.read`, `faculties.manage`, `students.create`, `students.import`, `students.read_full`, `enrollments.manage`, `classrooms.manage`, `beacons.manage`, `timetables.publish`, `class_sessions.start`, `class_sessions.cancel`, `class_sessions.void`, `class_reviews.decide`, `attendance.open`, `attendance.review_pending`, `attendance.assisted_checkin`, `attendance.correct`, `checkins.create`, `disputes.review`, `announcements.send_official`, `announcements.send_rep`, `reports.export_personal`, `risk_flags.review`. The full list lives in `packages/shared/src/permissions.ts` from Phase 1.

Protected keys (Super Admin only): `users.manage_admins`, `roles.assign`, `roles.edit_permissions`, `settings.manage`.

## How the server enforces this

**Built in Phase 1 step 5:** steps 1, 2 and 5 below, plus role switching and the scope lookup (`ScopeService`). Resource-level scope policies and scoped queries (steps 3–4) arrive with the resources they protect, starting in Phase 2. Routes declare `@Public()`, `@Authenticated()` or `@RequirePermissions(...)`; a route with none is refused, and a test checks that every route declares one.

1. **Authentication.** The access token identifies the user, the session and the active role. A person with two roles, such as a lecturer who is also an administrator, switches role from the profile menu. Each request is checked against the active role only, and the audit log records which role acted.
2. **Permission guard.** Every route declares its permission key, and a route without one is refused by default.
3. **Scope policy.** A policy function confirms the target is in scope, for example `canManageSection(user, sectionId)` or `isEnrolledIn(student, sessionId)`.
4. **Scoped queries.** List queries filter by scope in the database query itself, so an out-of-scope row never leaves the database. This blocks the classic attack of changing an ID in the URL to read someone else's data.
5. **Tests.** Every endpoint gets an automated test that a user without the permission or outside the scope receives `403` (test scenario 24).
