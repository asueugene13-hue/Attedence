# Testing

Every phase ships with automated tests, and a phase is not done until its tests run green in CI. Results are reported exactly as they ran: a test that was not executed is never reported as passing.

**Status (2026-11-08, end of Phase 1):** 141 automated tests and 1 browser journey pass locally. Of the 25 required scenarios, scenario 24 is done; the rest belong to Phases 3–6.

## 1. Test levels and tools

| Level | What it covers | Tools |
| --- | --- | --- |
| Unit | Pure logic: decision table, detection engine, transition table, attendance calculation, QR token signing, import row validation | Vitest |
| Integration | API endpoints against a real PostgreSQL and Redis: transactions, constraints, permissions, idempotency | Vitest, Supertest, real PostgreSQL, Redis and S3-compatible storage (SeaweedFS), as local Docker services and in CI. Tests use their own database, Redis database and storage bucket. No database mocks, because the constraints are what is being tested. |
| Realtime | Socket authentication, room permissions, `seq` gaps and reconnect | Vitest with `socket.io-client` |
| Background jobs | Checkpoints, sweeper recovery, retries, outbox relay | Vitest with a controllable clock and real Redis |
| Web end-to-end | Role dashboards, imports, timetable publishing, live roster | Playwright |
| Mobile | Components and screens; end-to-end flows on emulators and real devices | React Native Testing Library; Maestro |
| Field | BLE signal and GPS behaviour in real Knutsford classrooms | Site-survey checklist (PRESENCE_VERIFICATION.md §3), with results recorded |
| Load | Check-in bursts and roster fan-out | k6 |
| Security | Permission matrix per endpoint, token rotation and reuse, upload validation, rate limits, dependency audit | Vitest; OWASP ZAP baseline scan; `npm audit` |

Rules:

- Test data is obviously fake (for example "Test Student 001" or "TST/0001") and lives only in test fixtures.
- Time-dependent logic takes an injected clock, so tests can say "it is now T + 15 min" without waiting.
- Every bug fix comes with a test that failed before the fix.

## 2. The 25 required scenarios

| # | Scenario | Main level | Phase | Status |
| --- | --- | --- | --- | --- |
| 1 | Student checks in from the correct classroom | Unit + integration + field | 5 | **Integration done** (`test/check-in.test.ts` → "scenario 1": verified, present, attempt, evidence and rule trace kept; late after the late time). Field part: Phase 4 step 6. |
| 2 | Student tries to check in from home | Unit + integration | 5 | **Done.** Engine rows in `verification.test.ts`; `test/check-in.test.ts` → "scenarios 2 and 4" (rejected, retry allowed, records only move up, wrong room). |
| 3 | Student scans an expired QR | Unit + integration | 5 | **Done.** `attendance/qr.test.ts`; `test/check-in.test.ts` → "scenarios 3 and 12" (expired, no record; forged or edited codes invalid). |
| 4 | Student shares a QR screenshot | Integration | 5 | **Done.** `test/check-in.test.ts`: a live code used at home is rejected (no classroom evidence); a later screenshot is expired. |
| 5 | Unregistered student attempts attendance | Integration | 5 | **Done.** `test/check-in.test.ts` → "scenarios 5 and 6" (a non-student is refused, 403 NOT_A_STUDENT; scenario 24 covers anyone signed out). |
| 6 | Student from another course attempts attendance | Integration | 5 | **Done.** `test/check-in.test.ts`: NOT_ENROLLED, no record. |
| 7 | Duplicate attendance request | Integration (same idempotency key, and parallel requests) | 5 | **Done.** `test/check-in.test.ts` → "scenario 7" (same key twice and five at once: one attempt, same answer; different requests at once: one record). |
| 8 | Bluetooth disabled | Mobile + integration | 4–5 | **Integration done** (`test/check-in.test.ts` → "scenario 8"); tried on a real phone in Phase 4 step 4 ("Check this classroom"). |
| 9 | Beacon failure (degraded mode) | Integration + field | 4–5 | **Integration done** (`test/beacon-health.test.ts`; `test/check-in.test.ts` → "scenario 9": check-ins wait for the lecturer). Field part: Phase 4 step 6. |
| 10 | GPS inaccuracy | Unit | 4 | **Done.** `verification/verification.test.ts` (accuracy limits, error circles, uncertain readings never held against the student). |
| 11 | Student changes devices | Integration | 4 | **Done.** `test/devices.test.ts` (approval of a replacement); `test/check-in.test.ts` → "scenario 11" (an unapproved phone waits for the lecturer; one phone for two students goes to review and is flagged). |
| 12 | Internet connection failure (offline grace) | Mobile + integration | 5 | **Integration done** (`test/check-in.test.ts`: accepted within the offline grace, at most pending). Mobile part: step 6. |
| 13 | Lecturer cancels a class | Integration | 3 | **Done.** `test/class-monitoring.test.ts` → "a simulated teaching day" (students told in the app and by email); `test/class-lifecycle.test.ts` (reasons, who may cancel). |
| 14 | Lecturer delays a class | Integration + jobs | 3 | **Done.** `test/class-monitoring.test.ts` → "a simulated teaching day" (students told; monitoring waits for the new start); "a delay moves the checkpoints". |
| 15 | Lecturer reschedules a class | Integration (including a conflicting replacement) | 3 | **Done.** `test/class-monitoring.test.ts` → "a simulated teaching day"; `test/reschedules.test.ts` (blockers, warnings, re-check at approval, two approvals racing). |
| 16 | Students report a missing lecturer | Unit (engine) + jobs | 3 | **Done.** `detection-engine.test.ts` (thresholds); `test/class-monitoring.test.ts` → "a simulated teaching day" and "3 students (and 10%)…" (through the report job). |
| 17 | Course rep reports a class problem, and status does not change | Integration | 3 | **Done.** `test/class-monitoring.test.ts` → "a simulated teaching day"; "course rep rule" (unit and integration; D-13 corroboration). |
| 18 | Administrator reviews a class | Integration + web end-to-end | 3 | **Done.** "review decisions" tests; `test/class-monitoring.test.ts` → "a simulated teaching day"; `apps/web/e2e/05-classes.spec.ts` (publish a timetable, open a review, decide it in the browser). |
| 19 | Student disputes attendance | Integration + mobile | 6 | Not written |
| 20 | Lecturer makes an authorised correction | Integration | 5–6 | **Done.** `test/corrections.test.ts` → "scenario 20" (reason, correction row, audit, live update; refusals), "late corrections" (waits for an administrator; never applied to a record that changed since). |
| 21 | Cancelled class excluded from absence calculation | Unit (calculation) + integration | 5 | Not written |
| 22 | Lecturer's device crashes during attendance | Integration + realtime | 5 | **Done.** `test/roster.test.ts` → "scenario 22": live events stop when the phone dies; another device joins, sees from `seq` what it missed, reloads the full roster, and the QR carries on. |
| 23 | Background job fails and recovers | Jobs | 3 | **Done.** `test/class-monitoring.test.ts` → "a simulated teaching day" (an email outage recovers on retry); "a failed email is retried, then recorded as failed and reported to system health"; `test/jobs-and-settings.test.ts`. |
| 24 | Unauthorised user tries another role's dashboard or API | Integration: every discovered endpoint × every role (`test/scenario-24-unauthorised-access.test.ts`) + web end-to-end (sign-out redirect) | 1 onward | **Done.** New endpoints are covered automatically. |
| 25 | Many students check in at once | Integration (parallel) + load | 5 | **Started.** `test/check-in.test.ts`: the whole class at the same moment, each exactly once. The 500-check-in load test is step 7. |

## 3. Results log

| Date | Phase | Command | Result |
| --- | --- | --- | --- |
| 2026-11-08 | 1 (step 9) | `npm run check` | design-tokens 3, shared 10, API 111, web 8, mobile 9: **141 passed, 0 failed** |
| 2026-11-08 | 1 (step 9) | `npm run e2e -w @attendsure/web` | **1 passed** (first Super Admin journey in Chromium) |
| 2026-11-09 | 2 (step 7b) | `npm run e2e -w @attendsure/web` | **4 passed**: Super Admin first sign-in; Super Admin sets up structure, calendar, places, a lecturer, a course, offering, section and lecturer assignment through the screens and creates the Registrar; Registrar journey (as below); Super Admin appoints and ends a course rep |
| 2026-11-09 | 2 (step 7a) | `npm run e2e -w @attendsure/web` | **2 passed** (Super Admin journey; Registrar journey: activation from a real email in Mailpit, template download, import preview with bad rows and duplicates, error report, confirm, activation emails, photo, verification, status change, enrolment and drop) |
| 2026-11-08 | 1 (step 9) | Mutation check: permission guard forced to allow everything | Scenario 24 failed as it should (2 tests); passes again once restored |
