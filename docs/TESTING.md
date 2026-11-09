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
| 1 | Student checks in from the correct classroom | Unit + integration + field | 5 | Not written |
| 2 | Student tries to check in from home | Unit + integration | 5 | Not written |
| 3 | Student scans an expired QR | Unit + integration | 5 | Not written |
| 4 | Student shares a QR screenshot | Integration | 5 | Not written |
| 5 | Unregistered student attempts attendance | Integration | 5 | Not written |
| 6 | Student from another course attempts attendance | Integration | 5 | Not written |
| 7 | Duplicate attendance request | Integration (same idempotency key, and parallel requests) | 5 | Not written |
| 8 | Bluetooth disabled | Mobile + integration | 4–5 | Not written |
| 9 | Beacon failure (degraded mode) | Integration + field | 4–5 | Not written |
| 10 | GPS inaccuracy | Unit | 4 | Not written |
| 11 | Student changes devices | Integration | 4 | Not written |
| 12 | Internet connection failure (offline grace) | Mobile + integration | 5 | Not written |
| 13 | Lecturer cancels a class | Integration | 3 | Not written |
| 14 | Lecturer delays a class | Integration + jobs | 3 | Not written |
| 15 | Lecturer reschedules a class | Integration (including a conflicting replacement) | 3 | Not written |
| 16 | Students report a missing lecturer | Unit (engine) + jobs | 3 | Not written |
| 17 | Course rep reports a class problem, and status does not change | Integration | 3 | Not written |
| 18 | Administrator reviews a class | Integration + web end-to-end | 3 | Not written |
| 19 | Student disputes attendance | Integration + mobile | 6 | Not written |
| 20 | Lecturer makes an authorised correction | Integration | 5–6 | Not written |
| 21 | Cancelled class excluded from absence calculation | Unit (calculation) + integration | 5 | Not written |
| 22 | Lecturer's device crashes during attendance | Integration + realtime | 5 | Not written |
| 23 | Background job fails and recovers | Jobs | 3 | Not written |
| 24 | Unauthorised user tries another role's dashboard or API | Integration: every discovered endpoint × every role (`test/scenario-24-unauthorised-access.test.ts`) + web end-to-end (sign-out redirect) | 1 onward | **Done.** New endpoints are covered automatically. |
| 25 | Many students check in at once | Integration (parallel) + load | 5 | Not written |

## 3. Results log

| Date | Phase | Command | Result |
| --- | --- | --- | --- |
| 2026-11-08 | 1 (step 9) | `npm run check` | design-tokens 3, shared 10, API 111, web 8, mobile 9: **141 passed, 0 failed** |
| 2026-11-08 | 1 (step 9) | `npm run e2e -w @attendsure/web` | **1 passed** (first Super Admin journey in Chromium) |
| 2026-11-09 | 2 (step 7a) | `npm run e2e -w @attendsure/web` | **2 passed** (Super Admin journey; Registrar journey: activation from a real email in Mailpit, template download, import preview with bad rows and duplicates, error report, confirm, activation emails, photo, verification, status change, enrolment and drop) |
| 2026-11-08 | 1 (step 9) | Mutation check: permission guard forced to allow everything | Scenario 24 failed as it should (2 tests); passes again once restored |
