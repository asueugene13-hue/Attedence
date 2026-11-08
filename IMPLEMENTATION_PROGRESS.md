# Implementation progress

Read this first in every session, and update it after every implementation step.

**Current phase:** Phase 1, foundation. Steps 1–4 are done; step 5 (authorisation) is next.
**Last updated:** 2026-11-08

### Phase 1 steps

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Repository foundation: npm workspaces, TypeScript, lint, format, tests, CI, local Docker services, shared role and permission catalogue | Done (2026-11-08) |
| 2 | API skeleton: NestJS app and worker entry points, validated config, structured logging, health checks, Prisma connection | Done (2026-11-08) |
| 3 | Identity schema and migrations: users, roles, permissions, grants, sessions, tokens, devices, audit log (+ append-only trigger) | Done (2026-11-08) |
| 4 | Authentication: activation, login, refresh rotation with reuse detection, logout, password reset, lockout, TOTP for staff | Done (2026-11-08) |
| 5 | Authorisation: permission guard, scope policies, role switch, audit interceptor; Super Admin bootstrap command | Not started |
| 6 | Super Admin API: users, role grants, role permissions, settings, audit-log search | Not started |
| 7 | Web shell: Next.js, design tokens, login, MFA, role-aware sidebar, Super Admin screens | Not started |
| 8 | Mobile shell: Expo development build, login, secure token storage, role-based navigation | Not started; needs JDK 17 and Android Studio |
| 9 | Phase 1 exit: auth and RBAC test suite green in CI; scenario 24 covered for every Phase 1 endpoint | Not started |

## Phase status

| Phase | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| 0 Inspection and architecture | Design documents in `docs/` | Product owner approves; D-01 to D-07 decided | Done, approved 2026-11-08 |
| 1 Foundation | Monorepo, local services, API/web/mobile shells, database, sign-in, refresh tokens, MFA, roles and permissions, Super Admin tools, audit log, CI | Auth and RBAC tests pass in CI; first Super Admin created with a one-time command, not a seeded password | In progress (steps 1–4 of 9 done) |
| 2 Academic management | Faculties to semesters, calendar exceptions, courses, offerings, sections, students (manual and bulk import), lecturers, enrolments, course reps, basic classrooms | Registrar imports a template file end to end; duplicates and bad rows rejected with a downloadable error report | Not started |
| 3 Timetable and class monitoring | Timetables, conflict checks, publishing, session generation, class lifecycle, detection engine, issue reports, lecturer responses, notification delivery, escalation and reviews | Scenarios 13–18 and 23 pass in a simulated teaching day | Not started |
| 4 Classroom verification | Beacon registry and health, BLE scanning, GPS, trusted devices, integrity checks, verification engine, exception workflows | Field test in two real classrooms with recorded signal measurements | Not started |
| 5 Attendance | Dynamic QR, attendance sessions, check-in, live roster, history, calculation, fraud flags | Scenarios 1–12, 22 and 25 pass; load test of 500 simultaneous check-ins | Not started |
| 6 User experiences | Student and lecturer dashboards, digital student ID, notification centre, announcements, disputes, excuse requests | Scenarios 19–21 pass; screens match the design canvas | Not started |
| 7 Reports and administration | Admin dashboards, analytics, CSV/Excel/PDF exports, system monitoring, audit views | Every report respects role scope; exports are logged | Not started |
| 8 Production readiness | Security testing, load testing, device testing, backup and restore drill, deployment, user acceptance testing | Knutsford staff sign off on UAT; a restore drill succeeds | Not started |

## Recommended changes to the phase order

1. **Move basic classrooms into Phase 2.** Timetables (Phase 3) need rooms to exist. Campus, building and room records come early; beacons stay in Phase 4.
2. **Run a BLE hardware trial during Phase 2.** Buy 2–3 candidate beacons and test them in two real Knutsford classrooms with several Android phones and iPhones. The beacon type decides parts of the mobile code and the database, so settle it before Phase 4 (see D-08).
3. **Build notification delivery in Phase 3.** Reminders and escalation need push, email and the in-app record. Phase 6 adds the notification centre screens and preferences.

## Open decisions

### Needed before Phase 1

| ID | Decision | Recommendation | Why it matters |
| --- | --- | --- | --- |
| D-01 | Mobile toolchain | Expo development builds (not Expo Go) | Expo is the setup the React Native team recommends for new apps. It still allows native Bluetooth, location and FCM modules, and it can build iPhone apps in the cloud without a Mac. |
| D-02 | Monorepo tooling | npm workspaces, no extra build tool yet | npm is already installed and handles React Native's package layout well. Turborepo can be added later if builds get slow. |
| D-03 | Two-factor sign-in for Super Admin, Administrator and Registrar | Yes, with an authenticator app (TOTP) and recovery codes | These accounts can change records for every student. A stolen password alone should not be enough. |
| D-04 | Version control | Run `git init` now and push to a private GitHub repository | Gives history, an off-machine backup and automated checks (CI). |
| D-05 | Local tools | Install Docker Desktop (WSL 2), JDK 17 and Android Studio | PostgreSQL, Redis, SeaweedFS and Mailpit run in Docker. React Native's Android build expects JDK 17; this PC has JDK 27. |
| D-06 | First sign-in | The Registrar creates the account and an activation link goes to the student's university email; the student sets their own password | Requires every student to have a university email. If they don't, we use SMS one-time codes instead. |
| D-07 | University single sign-on | Ask Knutsford IT whether students and staff have Microsoft 365 or Google Workspace accounts | If they do, sign-in can use those accounts later. The Phase 1 design leaves room for that. |

### Needed later

| ID | Decision | Recommendation | Needed by |
| --- | --- | --- | --- |
| D-08 | Beacon hardware and protocol | Rotating-ID beacons (Eddystone-EID or a vendor's secure rotating ID), chosen after the classroom trial | Phase 4 |
| D-09 | Attendance rules: minimum percentage, late cut-off, whether late counts as attended, how excused absences count, when attendance closes | Take these from Knutsford's academic regulations. Interim defaults are in [ATTENDANCE_FLOW.md](docs/ATTENDANCE_FLOW.md) §9. | Phase 5 |
| D-10 | Student device policy | One trusted phone per student. The first phone is trusted at activation; a replacement needs Registrar or Administrator approval. | Phase 4 |
| D-11 | Who can reschedule a class | The lecturer requests; an Administrator approves | Phase 3 |
| D-12 | Who appoints course reps | An Administrator appoints; the lecturer may nominate | Phase 2 |
| D-13 | Monitoring thresholds | Unconfirmed at 15 min; escalate at 30 min, or earlier once at least 3 students and at least 10% of the class report a problem | Phase 3 |
| D-14 | Real academic data and ID formats | The Registrar and Administrators supply the structure. We need the real Student ID and Staff ID formats for validation. | Phase 2 |
| D-15 | Brand colours and crest | Knutsford supplies them; the design tokens are ready to swap | Phase 6 |
| D-16 | Hosting, data location, Data Protection Commission registration | University IT and the university's data protection lead decide | File storage by Phase 2; hosting before Phase 8 |
| D-17 | Email and SMS providers | The university's mail system or a transactional email service; a Ghanaian SMS gateway if SMS is wanted | Phase 3 |
| D-18 | Data retention periods | Proposals are in [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) §7 | Phase 5 |
| D-19 | Where the attendance QR is shown | Both: the lecturer's phone and a classroom projector through the web dashboard | Phase 5 |
| D-20 | Combined classes (one meeting serving several sections) | The schema supports it. Confirm whether it happens at Knutsford. | Phase 3 |

## Decisions log

| Date | ID | Decision | Decided by |
| --- | --- | --- | --- |
| 2026-11-08 | Phase 0 | Architecture plan approved; Phase 1 may start | Product owner |
| 2026-11-08 | D-01 | Expo development builds for the mobile app | Product owner |
| 2026-11-08 | D-02 | npm workspaces, no extra build tool | Product owner |
| 2026-11-08 | D-03 | TOTP two-factor sign-in required for Super Admin, Administrator, Registrar | Product owner |
| 2026-11-08 | D-04 | Git now; private GitHub repository (remote still to be created by the product owner) | Product owner |
| 2026-11-08 | D-05 | Install Docker Desktop (WSL 2), JDK 17, Android Studio | Product owner |
| 2026-11-08 | D-06 | Activation link to university email. Open question: does every student have one? If not, SMS codes are the fallback. | Product owner |
| 2026-11-08 | D-07 | Ask Knutsford IT about Microsoft 365 / Google accounts; design leaves room for SSO | Product owner |

## Session log

### 2026-11-08 — Phase 0

- **Found:** `C:\Users\USER\Desktop\Attendence` was empty and not a git repository. A design canvas already existed ([link](https://claude.ai/artifact/QA6eYPCN51FNpWASQbgLUV)) with 8 boards: design system v0.1 (proposed), information architecture, Student Home, check-in steps (scan, verifying, confirmed, not verified) and Lecturer Live Attendance on the web. It holds sample data only; the navy primary colour is a placeholder until Knutsford supplies brand colours.
- **Built:** README.md, CLAUDE.md, this file, and 14 design documents in `docs/`. No application code.
- **Commands run:** read-only checks of the folder and of installed tools (results in [SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) §8). Nothing was installed.
- **Tests run:** none, because there is no code yet.
- **Next step after approval:** Phase 1, step 1. Initialise the repository (npm workspaces, shared TypeScript and lint config, CI skeleton) and add the local Docker services.

### 2026-11-08 — Phase 1, step 1: repository foundation

- **Built:** npm workspaces root; shared TypeScript config (strict); ESLint and Prettier; Jest; GitHub Actions CI (format, lint, type-check, build, test, `npm audit --audit-level=high`); local Docker services; `.env.example`; `packages/shared` with the six role keys, the 64-key permission catalogue, default and configurable role grants from the approved matrix, and tests that enforce its rules.
- **Files:** `package.json`, `package-lock.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`, `.env.example`, `.github/workflows/ci.yml`, `infra/docker-compose.yml`, `infra/seaweedfs/s3.json`, `packages/shared/**`. Docs updated: README (getting started), DEPLOYMENT and SYSTEM_ARCHITECTURE (SeaweedFS).
- **Database changes:** none yet.
- **Commands run:** `git init -b main`; `npm install --save-dev --save-exact …`; `npx prettier --write .`; `npm run check`.
- **Tests run:** `npm run check` → format, lint, type-check and build clean; Jest 1 suite, **10 passed, 0 failed**.
- **Decisions made while building:**
  - TypeScript pinned to 6.0.3, not 7.0.2: typescript-eslint 8.72.1 supports `<6.1.0` and ts-jest 29.4.15 supports `<7`.
  - Local S3 storage uses SeaweedFS 4.52 because the MinIO image is no longer published on Docker Hub.
  - Images: postgres 18.6, redis 8.8.4-alpine, axllent/mailpit v1.33.1.
- **Known limitations:**
  - `docker-compose.yml` has not been started, because Docker Desktop is not installed yet.
  - `npm audit` reports 28 moderate issues (deepmerge, glob, minimatch), all inside Jest's development tooling. None are high or critical, and none ship in the app. The only offered fix is a forced breaking downgrade, so they are accepted for now and will be re-checked at each step.
  - The `@parcel/watcher` install script (a Jest watch-mode helper) was not approved to run. Normal test runs don't need it.
  - Nothing is committed to git yet, and there is no GitHub remote.
- **Next step:** Phase 1, step 2: the NestJS API skeleton. It needs Docker Desktop installed to connect to PostgreSQL.

### 2026-11-08 — Setup actions (product owner asked: commit, Docker, GitHub)

- **Git:** first commit `d2c2a0e` on `main` (38 files; `.env` excluded).
- **Installed (elevated):** WSL (`wsl --install --no-distribution`, exit 0) and Docker Desktop (winget `Docker.DockerDesktop`, exit 0; `docker --version` = 29.9.2).
- **Not yet working:** WSL 2 reports that virtualization or Virtual Machine Platform is not available. The hypervisor is already present, so a Windows restart is expected to finish enabling the component. Docker Desktop cannot run until WSL 2 starts.
- **GitHub:** the product owner created the private repository https://github.com/asueugene13-hue/Attedence (2026-11-08). `main` is pushed and tracks `origin/main`. The CI result is visible only when signed in, under the Actions tab.

### 2026-11-08 — Local services verified

- `npm run infra:up` started all four containers. Checks:
  - PostgreSQL 18.6 answered, and the `btree_gist` extension (needed for the no-double-booking constraints) installed.
  - Redis replied `PONG` with `appendonly yes`.
  - SeaweedFS refused anonymous and wrong-key requests and accepted the dev credentials; bucket `attendsure-local` was created.
  - Mailpit web UI answered 200.

### 2026-11-08 — Phase 1, step 2: API skeleton

- **Built:** `apps/api`, a NestJS 12 application with two entry points sharing one codebase:
  - `main.ts`: the HTTP API, with the `/api/v1` prefix and `x-powered-by` off.
  - `worker.ts`: the background worker, which has no queues yet.
  - Validated configuration (`AppConfig`, Zod). The app refuses to start on bad settings and names the variable without showing its value.
  - Structured logging (pino): request IDs, and authorization and cookie headers redacted.
  - Prisma 7 connection through the `pg` driver adapter.
  - Shared Redis connection.
  - `/health/live` and `/health/ready` (checks the database and Redis).
  - A global error filter returning RFC 9457 problem details, which hides internal error messages.
- **Files:** `apps/api/{package.json, tsconfig.json, tsconfig.build.json, nest-cli.json, vitest.config.ts, prisma.config.ts, prisma/schema.prisma}`, `apps/api/src/**` (config, logging, prisma, redis, health, filter, app/worker modules, entry points), `apps/api/test/{setup-env.ts, health.test.ts}`.
- **Also changed:**
  - `packages/shared` now uses ES modules and Vitest, and Jest was removed.
  - CI gained PostgreSQL 18.6 and Redis 8.8.4 service containers.
  - `.gitignore`, `.prettierignore` and `eslint.config.mjs` now ignore the generated Prisma client.
  - `allowScripts` approves only `@swc/core`, `prisma` and `@prisma/engines` at their pinned versions.
  - README, TESTING and SYSTEM_ARCHITECTURE updated.
- **Database changes:** none. The schema has no models yet, and Prisma generates an empty client.
- **Commands run:** `npm install` (pinned versions); `npm approve-scripts @swc/core prisma @prisma/engines`; `npx prisma generate`; `npm run typecheck` (failed once: Nest 12's `getInstance()` takes no type argument; fixed); `npx vitest run`; `npm run build`; manual runs of `dist/main.js`, `dist/worker.js` and an invalid-config start; `npm run check`.
- **Tests run:** `npm run check` exit 0. Shared: 1 file, **10 passed**. API: 2 files, **13 passed**. Those 13 are:
  - 6 config unit tests;
  - 7 integration tests against real PostgreSQL and Redis: live and ready probes, 404 problem details with a request ID, unsafe request ID replaced, unexpected error hidden, no `x-powered-by`, and ready returning 503 when Redis is unreachable.
- **Manual checks:**
  - The built API answered `/health/live` 200 and `/health/ready` 200 (database 21 ms, Redis up). An unknown route returned a 404 problem-details response.
  - The worker started, logged and stayed running.
  - A bad `PORT` and `DATABASE_URL` stopped start-up with exit code 1, listing both problems.
- **Decisions made while building:**
  - **NestJS 12 ships as ES modules**, so the API and the shared package are ES modules too.
  - **Tests use Vitest with SWC** instead of Jest, whose ES-module support is still experimental. SWC keeps the decorator metadata Nest needs; this is the setup NestJS's own docs describe.
  - **Prisma pinned to 7.10.1.** npm's `latest` tag currently points at an 8.0 release candidate.
  - **`@nestjs/config` not used.** A 40-line typed config class does the job with one less dependency.
- **Known limitations:**
  - `npm run dev` (Nest CLI watch mode) was checked after the log was first written: `/health/ready` answered 200.
  - Shutdown hooks were not tested with a real stop signal on Windows.
  - `npm audit`: 10 moderate issues in `minimatch` inside ESLint (development only). The CI gate (`--audit-level=high`) passes.
  - Security headers (Helmet), rate limiting and request validation arrive with steps 4–5.
- **Next step:** Phase 1, step 3. Identity schema and first migration: users, roles, permissions, role grants, sessions, refresh tokens, user tokens, devices and the audit log, with its append-only trigger, and a seed of the system roles and permissions from `packages/shared`.

### 2026-11-08 — Phase 1, step 3: identity schema, migrations and system-role seed

- **Built:**
  - Ten identity tables in `schema.prisma`, with snake_case names: `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `auth_sessions`, `refresh_tokens`, `user_tokens`, `user_devices`, `audit_logs`.
  - Two migrations with the hand-written rules Prisma cannot express. These are listed in DATABASE_SCHEMA.md §4 "Implemented so far":
    - lower-case emails;
    - scope consistency, and complete revocations, on role grants;
    - one active grant per user, role and scope;
    - one trusted attendance phone per user;
    - an append-only audit log;
    - protected permissions held only by SUPER_ADMIN.
  - Every foreign key is `RESTRICT`, except refresh tokens, which cascade with their session.
  - `seedSystemRoles` (`src/database/`) loads 6 roles, 64 permissions and 122 default grants from `packages/shared`. It is idempotent, never deletes a grant, and reports unknown permissions without deleting them.
  - A separate `attendsure_test` database for integration tests, created and migrated automatically before each test run.
  - CI now also runs migrate deploy, the seed and a drift check.
- **Files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/{20261108161435_identity, 20261108161550_protect_permissions}/migration.sql`, `apps/api/prisma.config.ts` (seed command), `apps/api/package.json` (`db:migrate`, `db:deploy`, `db:seed`, `db:drift`), `apps/api/src/database/{seed-system-roles.ts, seed.ts}`, `apps/api/test/{test-database.ts, global-setup.ts, setup-env.ts, identity-schema.test.ts}`, `apps/api/vitest.config.ts`, `.github/workflows/ci.yml`, `docs/DATABASE_SCHEMA.md`.
- **Database changes:**
  - In the development database `attendsure`: 10 tables, 2 partial unique indexes, 3 check constraints and 3 triggers, plus seeded roles, permissions and grants.
  - In the test database `attendsure_test`: the same schema, emptied by the tests.
- **Commands run:**
  - `prisma format`, `prisma validate`, `prisma migrate dev --create-only` (twice; the first draft was regenerated after switching optional links from `SET NULL` to `RESTRICT`), and `prisma migrate dev`.
  - `prisma migrate diff --from-config-datasource --to-schema … --exit-code`, which reported "No difference detected".
  - `npm run db:seed` twice (6 roles, 64 permissions and 122 grants created; then 0, 0 and 0).
  - `npm run check` and the CI database steps locally.
- **Tests run:** `npm run check` exit 0. Shared: **10 passed**. API: 3 files, **26 passed**. The 13 new tests cover:
  - the seed: complete, idempotent, keeps extra grants, reports unknown permissions;
  - the protected-permission triggers (both);
  - lower-case emails;
  - one active grant, and re-grant after revoke;
  - scope and revocation checks;
  - one trusted phone;
  - audit log UPDATE and DELETE refused;
  - unique refresh-token hash;
  - a user who appears in the audit log cannot be deleted.
- **Decisions made while building:**
  - Optional foreign keys are explicitly `RESTRICT`. Prisma's default, `SET NULL`, would silently blank history.
  - Tests use a separate `_test` database so they never wipe development data.
  - The test setup runs Prisma's CLI through Node directly rather than a shell, which avoids Node's DEP0190 warning.
- **Known limitations:**
  - TRUNCATE on `audit_logs` is not blocked. The row trigger covers UPDATE and DELETE, and the tests rely on TRUNCATE for clean-up. Production will use a database role without TRUNCATE privilege; that is set up with deployment (Phase 8).
  - `user_roles.scope_id` has no foreign key yet. Faculties and departments arrive in Phase 2, which will add a check that the scope exists.
  - The seed runs from built code (`npm run build` first).
- **Next step:** Phase 1, step 4: authentication. It covers account activation, login with Argon2id, short-lived access tokens, refresh-token rotation with reuse detection, logout, password reset, lockout after repeated failures, and TOTP two-factor sign-in for staff roles.

### 2026-11-08 — Phase 1, step 4: authentication

- **Built:**
  - **`POST /auth/login`** checks email and password with Argon2id (OWASP settings). Unknown emails take the same time, through a dummy hash, and get the same answer as wrong passwords.
  - **Lock-out:** after 5 wrong passwords in a row, 15 min, then 30, 60 … up to 24 h.
  - **Starting role:** the least-privileged role held, or a requested role the user holds.
  - **Two-step sign-in (TOTP) for Super Admin, Administrator and Registrar** (`/auth/mfa/enroll`, `/auth/mfa/verify`):
    - the secret is encrypted with AES-256-GCM;
    - a code can't be replayed (last time step stored, claimed atomically);
    - 10 single-use recovery codes, stored as hashes;
    - 5 wrong codes end the attempt (counted in Redis);
    - a successful challenge cannot open a second session.
  - **Sessions:**
    - Access tokens are JWTs (HS256, 15 min, separate audiences for access and MFA tokens) and are checked against the live session on every request.
    - Refresh tokens are 256-bit random values, stored hashed and rotated on every use; reusing an old one ends the session and is audited.
    - Web sessions last 12 h and use an httpOnly, Secure, SameSite=Strict cookie on `/api/v1/auth`, accepted only with the dashboard's `Origin`. Mobile sessions last 30 days and get the token in the response body.
  - **`/auth/logout`, `/auth/me`** (user, roles, active role, permissions).
  - **Activation link:** 72 h, single use. **Password reset:** 30 min, single use, same answer for unknown emails, ends all sessions. **Password change:** ends other sessions.
  - **Password rules:** 10–128 characters, not on the common list, not one repeated character, not containing the email name.
  - **Audit entries** for every sign-in event, without passwords.
  - **Supporting pieces:** encryption service, opaque-token helpers, SMTP mail service, audit service, shared request validation (`parseInput`), and request schemas in `packages/shared/src/auth.ts`.
- **Files:**
  - `apps/api/src/modules/auth/*` (controller, service, password, lockout, token, session, MFA, link tokens, guard, errors, common passwords, unit tests).
  - `apps/api/src/modules/audit-logs/*`, `apps/api/src/infrastructure/{crypto,mail}/*`, `apps/api/src/common/{request-context.ts, validation/parse-input.ts}`.
  - `apps/api/src/config/app-config.ts` (new required settings; production refuses the example secrets and plain http), `apps/api/src/app.module.ts`, `apps/api/src/configure-app.ts` (cookie parsing).
  - `apps/api/test/{auth.test.ts, fixtures.ts}`, `packages/shared/src/auth.ts`, `.env.example`, `.github/workflows/ci.yml`.
  - Docs: API_DOCUMENTATION, SECURITY, KNOWN_LIMITATIONS.
- **Database changes:** migration `*_mfa_recovery` adds `users.mfa_last_time_step` and the `mfa_recovery_codes` table. The drift check reports no difference.
- **Dependencies added (pinned):** argon2 0.45.2, jose 6.2.15, otplib 13.6.0, nodemailer 10.4.0, cookie-parser 1.4.7, zod 4.6.7 in shared; dev: @types/nodemailer 8.0.2, @types/cookie-parser 1.4.10. `npm audit`: 0 vulnerabilities reported at install.
- **Commands run:**
  - Install, migrate, generate and type-check.
  - `npx vitest run`. The first run had 4 failures: one shared length limit (200 characters) also applied to the MFA token, which is a longer JWT; it got its own limit.
  - A real activation email sent through SMTP to Mailpit, using the test database. Mailpit received "Activate your AttendSure account" from no-reply@localhost.
  - `npm run check`.
- **Tests run:** `npm run check` exit 0. Shared: **10 passed**. API: 5 files, **66 passed**. The 40 new tests are:
  - 28 HTTP integration tests covering activation, login, lock-out, roles, unknown fields, `/auth/me`, tampered and revoked tokens, suspension, refresh rotation and reuse, cookie origin, client mismatch, role revoked, reset, change, MFA enrolment, replay, recovery codes, attempt cap, MFA token not usable as an access token, and the audit trail;
  - 10 unit tests (lock-out, password rules, tokens, encryption);
  - 2 config tests.
- **Decisions made while building:**
  - HS256 signing with one server secret. This is enough while one service signs and checks tokens.
  - Lock-out uses the same generic message as a wrong password, so it does not reveal which emails exist.
  - The TOTP replay test replays the exact enrolment code, so it cannot fail at random when the 30-second window rolls over.
  - The argon2 install script is not approved: its prebuilt binary loads without it.
- **Known limitations:** see KNOWN_LIMITATIONS.md items 17–20:
  - a starter common-password list;
  - no per-IP rate limits yet;
  - strict reuse detection can end a session when two tabs refresh at once;
  - reset email is not retried.
  - Also: sign-in is by email only until Student and Staff ID numbers exist (Phase 2), and there is no endpoint yet to create accounts (step 6).
- **Next step:** Phase 1, step 5: authorisation.
  - Every route requires sign-in by default.
  - Permission guard with route-declared keys, and scope policies.
  - Role switching (`/auth/switch-role`).
  - Audit interceptor, Helmet security headers, per-IP rate limiting (sign-in, reset, MFA).
  - A one-time command that creates the first Super Admin.
