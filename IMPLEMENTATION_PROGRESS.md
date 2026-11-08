# Implementation progress

Read this first in every session, and update it after every implementation step.

**Current phase:** Phase 2, academic management. Steps 1–3 are done; step 4 (student registration and scoped administrator grants) is next. Phase 1 is complete and green in CI; its native Android build still needs JDK 17 and the Android SDK.
**Last updated:** 2026-11-08

### Phase 1 steps

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Repository foundation: npm workspaces, TypeScript, lint, format, tests, CI, local Docker services, shared role and permission catalogue | Done (2026-11-08) |
| 2 | API skeleton: NestJS app and worker entry points, validated config, structured logging, health checks, Prisma connection | Done (2026-11-08) |
| 3 | Identity schema and migrations: users, roles, permissions, grants, sessions, tokens, devices, audit log (+ append-only trigger) | Done (2026-11-08) |
| 4 | Authentication: activation, login, refresh rotation with reuse detection, logout, password reset, lockout, TOTP for staff | Done (2026-11-08) |
| 5 | Authorisation: permission guard, scope policies, role switch, audit interceptor; Super Admin bootstrap command | Done (2026-11-08) |
| 6 | Super Admin API: users, role grants, role permissions, audit-log search (settings moved to Phase 3, when first used) | Done (2026-11-08) |
| 7 | Web shell: Next.js, design tokens, login, MFA, role-aware sidebar, Super Admin screens | Done (2026-11-08) |
| 8 | Mobile shell: Expo development build, login, secure token storage, role-based navigation | Done except the native build (needs JDK 17 and the Android SDK) |
| 9 | Phase 1 exit: auth and RBAC test suite green in CI; scenario 24 covered for every Phase 1 endpoint | Done; CI green |

## Phase status

| Phase | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| 0 Inspection and architecture | Design documents in `docs/` | Product owner approves; D-01 to D-07 decided | Done, approved 2026-11-08 |
| 1 Foundation | Monorepo, local services, API/web/mobile shells, database, sign-in, refresh tokens, MFA, roles and permissions, Super Admin tools, audit log, CI | Auth and RBAC tests pass in CI; first Super Admin created with a one-time command, not a seeded password | Done; CI green 2026-11-08 (native mobile build still open) |
| 2 Academic management | Faculties to semesters, calendar exceptions, courses, offerings, sections, students (manual and bulk import), lecturers, enrolments, course reps, basic classrooms | Registrar imports a template file end to end; duplicates and bad rows rejected with a downloadable error report | In progress (steps 1–3 of 7 done) |
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

### 2026-11-08 — Phase 1, step 5: authorisation

- **Built:**
  - **Global guards, in order:** request limits → sign-in (`AccessTokenGuard`) → permissions (`PermissionGuard`).
  - **Access rules.** Every route must declare `@Public()`, `@Authenticated()` or `@RequirePermissions(...)`. A route with no rule is refused (`ACCESS_NOT_DECLARED`), even for the Super Admin, and a test fails if any real route lacks one.
  - **Permission checks** use the active role's grants, cached in Redis for 60 s, with `invalidate()` when grants change. If Redis is down, the database is read directly. Refusals are audited (`authz.denied`).
  - **Staff roles** (Super Admin, Administrator, Registrar) are accepted only on sessions whose sign-in passed two-step verification (new column `auth_sessions.mfa_verified_at`).
  - **`POST /auth/switch-role`** changes the session's active role and issues a new access token; the old token stops working at once. Switching into a staff role needs a two-step-verified session (`MFA_REQUIRED`). Audited.
  - **`ScopeService`** reads institution-wide, faculty and department grants for a role. Resource-level scope policies come with the resources in Phase 2.
  - **Redis fixed-window rate limits,** shared by all API instances:
    - default 3,000 per minute per IP (high because campus Wi-Fi shares addresses);
    - login 300 per minute per IP, plus 10 per 15 min per IP+email;
    - password reset 3 per hour per email, plus 30 per 15 min per IP;
    - MFA verify 60 per minute; activate and reset 30 per 15 min.
    - A blocked request gets 429 with `Retry-After`. Emails are hashed in Redis keys. If Redis is down, limits are skipped (logged).
  - **Helmet security headers** with a strict CSP for this JSON-only API.
  - **`TRUST_PROXY_HOPS`** setting, so rate limits see real client IPs behind load balancers.
  - **One-time first-Super-Admin command** (`npm run admin:create-super-admin`): creates a `PENDING_ACTIVATION` account with the SUPER_ADMIN grant and an activation link, records a SYSTEM audit entry, and refuses once any Super Admin exists.
- **Files:**
  - `apps/api/src/modules/authorization/*` (decorators, permission guard and service, scope service, module), `apps/api/src/common/rate-limit/rate-limit.ts`.
  - `apps/api/src/modules/auth/{access-token.guard.ts, auth.controller.ts, auth.service.ts, session.service.ts, auth.module.ts}`.
  - `apps/api/src/modules/users/bootstrap-super-admin.ts`, `apps/api/src/cli/create-super-admin.ts`.
  - `apps/api/src/{app.module.ts, configure-app.ts, config/app-config.ts}`, `apps/api/src/modules/health/health.controller.ts`.
  - `packages/shared/src/auth.ts` (switch-role schema).
  - `apps/api/test/{authorization.test.ts, health.test.ts, fixtures.ts, setup-env.ts, test-database.ts, auth.test.ts}`.
  - `.env.example`; docs: SECURITY, ROLE_PERMISSION_MATRIX, KNOWN_LIMITATIONS, DEPLOYMENT, README.
- **Database changes:** migration `*_session_mfa_verified` adds `auth_sessions.mfa_verified_at`. The drift check reports no difference.
- **Dependencies added:** helmet 8.3.0. `npm audit`: the same 10 moderate `minimatch` issues inside ESLint; the CI gate (high) passes.
- **Commands run:**
  - Migrate, generate, type-check, `npx vitest run`.
  - The first run had 1 failure: the health test's deliberately failing route had no access rule, so it was correctly refused with 401. It was marked `@Public()`.
  - The CLI against the test database:
    - bad input → exit 2 with the reasons;
    - first run → account and link printed, exit 0;
    - second run → refused, exit 3.
  - `npm run check`.
- **Tests run:** `npm run check` exit 0. Shared: **10 passed**. API: 6 files, **83 passed**. The 17 new tests cover:
  - deny-by-default, including a route-coverage test that found all 13 real routes declared;
  - each kind of access rule;
  - an audited refusal;
  - several required permissions on one route;
  - cache invalidation;
  - staff role without two-step verification refused;
  - role switch, including old token retired, refresh keeping the role, a role not held, and two-step needed for a staff role;
  - scopes;
  - per-account login limit with `Retry-After`;
  - per-email reset limit;
  - security headers;
  - the bootstrap → activate → MFA-required flow, and refusal on a second run.
- **Decisions made while building:**
  - Rate limiting is our own small Redis guard instead of `@nestjs/throttler` plus a third-party Redis store: one fewer dependency, and limits per IP+email are built in.
  - When Redis is down, rate limits fail open and permission checks fall back to the database.
  - Tests use Redis database 1, so they can clear counters safely.
  - Permission refusals are audited in the guard; domain services keep auditing their own changes. No generic audit interceptor, which would duplicate entries.
- **Known limitations:**
  - Scope policies for specific resources (a faculty's courses, a lecturer's sections) don't exist yet, because the resources don't; they arrive with them from Phase 2.
  - Rate limits are fixed-window: up to twice the limit can pass at a window boundary.
  - Per-user limits for busy signed-in routes come with check-in (Phase 5).
- **Next step:** Phase 1, step 6, the Super Admin API:
  - list, create (with activation email), view, suspend and restore staff accounts;
  - grant and revoke roles, with scope;
  - edit unprotected role permissions, with cache invalidation;
  - institution settings, versioned;
  - audit-log search.
  - Every action is audited, with a reason where the matrix requires one.

### 2026-11-08 — Phase 1, step 6: Super Admin API

- **Built:**
  - **Accounts:**
    - `GET/POST /users` (list with text, status and role filters and a cursor; create a staff account with its roles and an activation email);
    - `GET /users/:id` (roles, grant history, active sessions; no hashes or secrets);
    - suspend and restore with a reason (suspending ends every session);
    - resend activation;
    - reset another person's two-step sign-in.
  - **Role grants:** `POST /users/:id/roles` and `/roles/:grantId/revoke`, with a reason. Revoking ends the sessions acting in that role.
  - **Role permissions:** `GET /roles` (held and assignable per role) and `PUT /roles/:key/permissions`:
    - limited to each role's defaults plus its configurable cells from the matrix;
    - students and course reps can never receive attendance or class-control permissions;
    - the Super Admin role itself is fixed;
    - the cache is invalidated after commit.
  - **`GET /audit-logs`:** filters by action prefix, entity, actor and date range, newest first, cursor pages. Each search is itself audited. Administrators scoped to a faculty are refused for now (`SCOPE_REQUIRED`).
  - **Safeguards**, enforced with row locks so concurrent admins cannot race past them:
    - no suspending yourself or resetting your own two-step sign-in;
    - no removing your own Super Admin role;
    - never leaving zero active Super Admins (`LAST_SUPER_ADMIN`);
    - only a Super Admin can suspend or restore staff administrators, even if another role is given `accounts.suspend`.
  - **Seed fix:** default grants are now added only for roles or permissions that are new in that run. Before, the seed would have put back a default permission the Super Admin had removed on purpose.
- **Not built (on purpose):** the settings endpoints moved to Phase 3. No setting is read by any code yet, and an editable setting with no effect would break the "no buttons that do nothing" rule.
- **Files:**
  - `apps/api/src/modules/users/{users.service.ts, users.controller.ts, users.module.ts}`, `apps/api/src/modules/roles/*`.
  - `apps/api/src/modules/audit-logs/{audit-logs.controller.ts, audit-logs.module.ts, audit.module.ts}`. The search endpoint is in its own module so the worker doesn't load it.
  - `apps/api/src/database/seed-system-roles.ts`, `apps/api/src/app.module.ts`, `packages/shared/src/admin.ts`.
  - `apps/api/test/{super-admin.test.ts, fixtures.ts (signInAs), identity-schema.test.ts}`; docs: API_DOCUMENTATION.
- **Database changes:** none. The drift check reports no difference.
- **Commands run:**
  - Type-check, `npx vitest run`, built-worker start check, `npm run check`, `npm audit`, `npm run db:drift`.
  - Mutation check: with the last-Super-Admin rule switched off, its 2 tests failed; with it restored, they passed.
- **Tests run:** `npm run check` exit 0. Shared: **10 passed**. API: 7 files, **107 passed**. The 24 new tests cover:
  - account creation (including email failure and resend), duplicates and invalid input, Super Admin only;
  - list filters and cursor, 404 and 400, no secrets in responses;
  - suspend and restore, including sessions ended, login refused, self-suspension, protected targets, and the concurrent last-Super-Admin case;
  - role grant, duplicate, revoke ending sessions, own Super Admin role, and the concurrent last-Super-Admin case;
  - two-step reset, including on yourself;
  - role permission listing, a configurable grant that takes effect at once, refusals, and a removed default surviving a re-seed;
  - audit search with self-audit, and refusal for a faculty-scoped administrator.
- **Known limitations:**
  - Editing an account's name and phone waits for Phase 2 profiles.
  - Faculty and department role scopes wait for the academic tables (Phase 2).
  - `npm audit` in CI depends on npm's audit service; a network failure there fails the job even when nothing is wrong. The same 10 moderate `minimatch` issues remain inside ESLint.
- **Process note:** while checking the worker, a broad `taskkill` filtered on window title was run, which may have stopped other Node.js processes on this PC. One Node.js process from 3:29 PM survived and the Docker services were unaffected. Processes are stopped only by their own ID from now on.
- **Next step:** Phase 1, step 7: the web shell.
  - Next.js app with design tokens from the canvas.
  - Sign-in with the two-step screens, activation and password-reset pages.
  - Role-aware sidebar driven by `/auth/me` permissions.
  - Super Admin screens for accounts, roles and the audit log, wired to the API built so far.

### 2026-11-08 — Phase 1, step 7: web shell

- **Built:**
  - **`packages/design-tokens`:** colours (light and dark), type, spacing and radius from the design canvas. TypeScript is the single source; the build writes `tokens.css` for the web, and the mobile app will import the same values.
  - **`apps/web`:** a Next.js 16 / React 19 dashboard.
    - Sign-in pages: sign in; two-step sign-in with first-time setup (QR code, setup key, recovery codes shown once with a "saved them" checkbox) and a recovery-code fallback; activation; forgot password; reset password; change password.
    - Signed-in shell: a sidebar that shows only screens the active role's permissions allow; a role switcher for people with several roles; sign out.
    - Super Admin screens:
      - **Accounts:** search, status and role filters, "Load more" paging.
      - **New staff account:** with field errors and a notice when the activation email could not be sent.
      - **Account detail:** status, two-step state, devices, roles with grant and remove, role history, suspend, restore, reset two-step sign-in, resend activation. Every sensitive action asks for a reason in a confirmation dialog.
      - **Roles and permissions:** per-role checkboxes limited to the matrix; Super Admin shown as fixed; save with a reason.
      - **Audit log:** action prefix and record filters; reasons and before/after shown.
    - Sign-in handling:
      - The access token stays in memory only; the refresh token stays in the API's httpOnly cookie.
      - The browser talks only to the dashboard's own origin: Next.js forwards `/api/v1` to the API, so there is no CORS opening.
      - Renewal is single-flight across tabs (Web Locks). This fixes known limitation 19 for the dashboard.
    - Security headers on dashboard pages: frame-ancestors none, X-Frame-Options, nosniff, no-referrer, Permissions-Policy. A script CSP is still to come.
    - All dates shown in Africa/Accra time.
  - **Tests:**
    - Vitest unit tests for the API client, the sidebar filter and the reason dialog.
    - A Playwright end-to-end test of the whole first-Super-Admin journey in Chromium, against the real built API on its own database (`attendsure_e2e`, Redis database 2):
      1. the real create-super-admin command, its activation link, and a weak password rejected;
      2. sign-in, two-step setup with a generated TOTP code, and recovery codes;
      3. the sidebar contents, then a reload that keeps the session;
      4. create a Registrar account;
      5. suspend it, first without a reason (refused), then with one;
      6. find the suspension in the audit log with its reason;
      7. sign out; protected pages then redirect to sign-in.
    - Screenshots are saved to `apps/web/test-results/screens/`.
  - CI installs Chromium and runs the end-to-end test.
- **Files:**
  - `packages/design-tokens/*`.
  - `apps/web/{package.json, tsconfig.json, next.config.ts, vitest.config.ts, playwright.config.ts}`.
  - `apps/web/src/app/**` (13 pages), `apps/web/src/components/*`, `apps/web/src/lib/*`.
  - `apps/web/e2e/*`.
  - `eslint.config.mjs` (React-hooks rules and browser globals for the web), `.gitignore`, `.github/workflows/ci.yml`.
  - Docs: README, KNOWN_LIMITATIONS (items 21–24).
- **Database changes:** none to the schema. A new local database, `attendsure_e2e`, is used only by the browser test.
- **Dependencies added (pinned):**
  - Web: next 16.4.5, react 19.3.1, react-dom 19.3.1, @tanstack/react-query 5.107.1, qrcode 1.5.4.
  - Web dev: @playwright/test 1.65.0, @testing-library/react 16.3.3, @testing-library/user-event 14.6.8, jsdom 31.0.0, @vitejs/plugin-react 6.2.1, @types/react and @types/react-dom 19.3.0, @types/qrcode 1.5.6, otplib 13.6.0, pg and @types/pg 8.23.1.
  - Root dev: eslint-plugin-react-hooks 7.1.1.
  - Chromium downloaded by Playwright.
- **Commands run:** installs; `next typegen`; `tsc --noEmit`; `eslint`; `next build` (13 routes); `vitest run`; `playwright test` (4 runs); `npm run check`.
- **Problems hit and fixed:**
  - The first web install did not complete, likely because it ran while the local design-tokens package was still being linked; the second run worked.
  - A lint-disable comment named a rule from a plugin that isn't installed; it was removed.
  - Playwright starts the servers before its setup script, so the API came up before its database existed. The API's start script now prepares the database.
  - The test looked for the field "New password" by its visible label, which includes the required-field asterisk; it now uses the accessible name.
  - Shell escaping damaged one setup-script edit and one documentation line; both were fixed by direct edits.
- **Tests run:**
  - `npm run check` exit 0: design-tokens **3 passed** (including WCAG AA contrast in light and dark), shared **10 passed**, API **107 passed**, web **8 passed**.
  - `playwright test`: **1 passed**, on each of the last 3 runs, including after formatting.
- **Decisions made while building:**
  - Plain controlled forms validated with the shared Zod rules, instead of adding React Hook Form; the forms are small.
  - The browser's native `<dialog>` element instead of a dialog library.
  - The `/api/v1` proxy instead of CORS.
  - Inter is not bundled (system-font fallback).
  - The dark-mode colours the canvas did not specify (hover, tint and status backgrounds) were chosen and checked for contrast.
- **Known limitations:**
  - KNOWN_LIMITATIONS items 21–24: no script CSP yet; page guards in the browser are a convenience only; Inter is not bundled; the proxy target is fixed at build time.
  - The "Account created" notice stays on the account page until you leave it.
  - Without Mailpit or SMTP (as in CI), new accounts show the "email could not be sent" notice, which the test accepts.
- **Next step:** Phase 1, step 8: mobile shell.
  - Expo development build.
  - Sign-in with secure token storage.
  - Role-based navigation (student tabs; lecturer tabs).
  - Design tokens shared from `packages/design-tokens`.
  - This needs JDK 17 and Android Studio on this PC (D-05).

### 2026-11-08 — Phase 1, step 8: mobile shell (native build pending)

- **Built:** `apps/mobile`, an Expo SDK 58 app (React Native 0.88.1, React 19.3.0) using React Navigation.
  - Sign-in as a MOBILE client.
    - The 30-day refresh token is kept in the phone's secure storage (Keychain / Keystore, readable only while the phone is unlocked, never backed up). The access token stays in memory.
    - Single-flight renewal and one retry on 401.
    - A stored session resumes at start-up; a session the server has ended is forgotten.
  - Two-step code entry for staff, or a pointer to the web dashboard when two-step sign-in is not yet set up.
  - Role-based bottom tabs (Home, Profile), listing only screens that exist.
    - Home tells each role what will appear there; staff roles are pointed to the web dashboard.
    - Profile shows the account, a role switcher and sign-out (which works offline too).
  - Light and dark themes from `@attendsure/design-tokens`.
  - The API address comes from `EXPO_PUBLIC_API_URL` (default `http://10.0.2.2:3000`, the Android emulator's address for this PC).
  - Android permissions reduced to internet access only. Expo's default storage, overlay, vibration and microphone permissions are blocked in release builds; overlay windows stay in debug builds for the developer error screen.
- **Monorepo fix:** the repo now uses a single React 19.3.0, set by the root `overrides` and root devDependencies. React Native's renderer requires an exact React version, and two copies (19.3.0 for mobile, 19.3.1 for web) would have crashed the app at start. The web app moved to 19.3.0, and its browser journey was re-run and passes.
- **Files:**
  - `apps/mobile/{package.json, app.config.ts, tsconfig.json, metro.config.js, jest.config.js, jest.setup.ts, index.ts}`, `apps/mobile/src/**` (App, auth, API client, token store, theme, components, 4 screens, navigation, tests).
  - Root `package.json` (React overrides and pins), `apps/web/package.json` (React 19.3.0).
  - `eslint.config.mjs` (mobile included; generated folders ignored), `.gitignore`, `.github/workflows/ci.yml` (Android bundle check).
  - Docs: README, KNOWN_LIMITATIONS (items 25–27).
- **Database changes:** none.
- **Dependencies added (pinned):**
  - expo 58.0.23, expo-dev-client 58.0.18, expo-secure-store 58.0.2, expo-status-bar 58.0.4, expo-system-ui 58.0.7;
  - react-native 0.88.1, react 19.3.0;
  - @react-navigation/native 7.5.1, bottom-tabs 7.21.0, native-stack 7.21.0, react-native-screens 4.30.1, react-native-safe-area-context 5.11.1, @tanstack/react-query 5.107.1;
  - dev: jest-expo 58.0.14, jest 30.5.2, @types/jest 30.0.0, @testing-library/react-native 14.1.0.
  - React Native versions were chosen by `expo install` for SDK 58.
- **Commands run:**
  - Java 17 install with elevation: cancelled at the Windows prompt; not retried.
  - Installs and `npx expo install`; `npm dedupe`; React overrides.
  - `tsc --noEmit`; `npx jest`.
  - `expo export --platform android`: bundled, 1,031 modules, 2.9 MB Hermes bytecode.
  - `npx expo-doctor`: 20/20 checks pass, after merging a leftover `app.json` into `app.config.ts`.
  - `expo prebuild --platform android`: native project generated, `applicationId app.attendsure.mobile`, permissions checked.
  - `npm run check`; `npm audit`; Playwright (web).
- **Problems hit and fixed:**
  - Again, the first install into a new workspace did not complete until the workspace was linked.
  - The two React versions, as above.
  - Jest's rule that module mocks may only use variables named `mock…`.
  - Testing Library 14's `render` and events are now async.
  - The safe-area provider renders nothing in tests without the library's own mock.
  - Shell quoting broke one combined command, so nothing ran; it was redone with a script file.
- **Tests run:** `npm run check` exit 0.
  - design-tokens **3**, shared **10**, API **107**, web **8**, mobile **9** passed (**137** in total).
  - The 9 mobile tests cover: sign-in screen with no session; resuming and rotating a stored session; forgetting a revoked session; student sign-in storing the token securely; the wrong-password message; the staff "set up on web first" path; a staff two-step code; sign-out clearing storage and calling logout; tabs listing only built screens.
  - Playwright (web): **1 passed** after the React change.
  - `npm audit --audit-level=high`: passes (33 moderate and 1 low remain, in Jest's and ESLint's development dependencies).
- **Known limitations:** KNOWN_LIMITATIONS items 25–27:
  - no native build or device run yet;
  - placeholder app identifiers;
  - two-step setup is web-only.
- **Next step:**
  - For the product owner: install JDK 17 and Android Studio (D-05), then this step's native build and an emulator run can be completed.
  - Phase 1 step 9, the Phase 1 exit check: CI green on GitHub; auth and RBAC suites complete; scenario 24 (unauthorised access) covered for every Phase 1 endpoint; documentation review.

### 2026-11-08 — Phase 1, step 9: exit check

- **Built:** `apps/api/test/scenario-24-unauthorised-access.test.ts`.
  - It discovers every route from the running app, so endpoints added later are covered automatically.
  - Every non-public route refuses a request without sign-in (401).
  - Every permission-protected route refuses each role whose default grants lack a required permission (403 `PERMISSION_DENIED`) before validation runs. The test sends an empty body, so a 400 would mean validation ran first.
  - Every protected route is tried by at least one role that may not use it, and every refusal is audited.
  - Found 25 routes: 12 permission-protected, 4 for any signed-in user, 9 public.
- **Mutation check:** with the permission guard forced to allow everything, 2 of the 4 scenario-24 tests failed; with it restored, all passed.
- **Documentation review:** README status; TESTING (status, scenario 24 done, results log); DEPLOYMENT (local setup); SYSTEM_ARCHITECTURE §8 (Docker installed).
- **Tests run:**
  - `npm run check` exit 0: design-tokens 3, shared 10, API **111**, web 8, mobile 9, so **141 passed, 0 failed**.
  - Playwright: **1 passed**.
  - One lint error (`let` should be `const`) was caught and fixed on the way.

#### Phase 1 exit criteria

| Criterion | Status |
| --- | --- |
| Auth and RBAC tests pass | **Yes, locally** (141 tests plus the browser journey). **In CI: not confirmed.** The repository is private and this PC has no GitHub CLI, so the product owner must open the Actions tab. |
| First Super Admin created with a one-time command, not a seeded password | **Yes.** `admin:create-super-admin`, tested in the API suite and used for real in the browser journey. |
| Scenario 24 covered for every Phase 1 endpoint | **Yes.** Automatic, including future endpoints. |
| Web shell signs in, enforces two-step sign-in for staff, and shows only permitted screens | **Yes.** Proven in Chromium. |
| Mobile shell signs in with secure storage and role-based navigation | **Partly.** JavaScript tested, bundled, doctor 20/20, native project generated; **not yet built or run on a device** (JDK 17 and Android SDK missing; D-05). |

#### Before Phase 2 can start
1. The product owner confirms the latest CI run on GitHub is green, or sends the failing step so it can be fixed.
2. The product owner approves Phase 2 (academic management).
3. Optional but recommended: install JDK 17 and Android Studio, so the mobile native build can be completed and kept working.
4. Decisions needed during Phase 2: D-12 (who appoints course reps), D-14 (real Student and Staff ID formats, and who supplies the academic structure), D-16 (where uploaded files are stored), and the BLE beacon trial (D-08).

### 2026-11-08 — CI repair (found after the repository was made public)

- **What was wrong:** GitHub CI had failed on every push from step 3 (`9a4d225`) to step 9 (`1581216`). Steps 1–2 passed. The cause: `npm run typecheck` ran before anything was built, and on a fresh machine `packages/shared/dist` does not exist yet, so the API could not resolve `@attendsure/shared` ("Cannot find module"). Every check passed on this PC only because the packages had already been built here. Earlier progress entries reported local results; none claimed CI was green, but the CI result had not been checked until the repository became public.
- **Fix:** a root `build:packages` script (shared + design-tokens) now runs before `typecheck` and `test`.
- **How it was verified:** a fresh `git clone` in a scratch folder, `npm ci`, no `.env`, CI-style environment variables and separate databases (`attendsure_ci`, Redis database 3). Every CI step was run in CI's order: format, lint, typecheck, build, test, mobile bundle, migrate/seed/drift, Playwright e2e (1 passed), `npm audit --audit-level=high`. **All passed.**
- **Lesson kept for future steps:** before reporting a step as done, rehearse CI from a clean clone, then check the actual GitHub run.
- **GitHub result:** run 42515039638 on `15433f9`, **success**. Every step passed: install, format, lint, typecheck, build, test, mobile bundle, migrate/seed/drift, Playwright install, end-to-end test and the audit gate.

## Phase 2: academic management

Approved by the product owner 2026-11-08 ("next" after Phase 1 was confirmed green).

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Academic structure: faculties, departments, programmes, levels, academic years, semesters, calendar exceptions | Done (2026-11-08) |
| 2 | Places: campuses, buildings, classrooms (geofences for later) | Done (2026-11-08) |
| 3 | Courses, offerings, sections; lecturer profiles and assignments | Done (2026-11-08) |
| 4 | Student registration (Registrar); faculty- and department-scoped administrator grants | Not started |
| 5 | Bulk student import (CSV/XLSX): templates, validation, preview, confirm, error report, history | Not started |
| 6 | Enrolments and course-rep assignments | Not started |
| 7 | Dashboard screens, end-to-end tests, Phase 2 exit check | Not started |

### 2026-11-08 — Phase 2, step 1: academic structure

- **Built:**
  - Seven tables: `faculties`, `departments`, `programmes`, `academic_levels`, `academic_years`, `semesters`, `calendar_exceptions`. Nothing about Knutsford is seeded.
  - 23 endpoints (see API_DOCUMENTATION, "Academic structure").
  - **Access rules:**
    - Reads need `academic_structure.read` (Super Admin, Administrator, Registrar).
    - Faculties and levels need university-wide scope.
    - Departments and programmes may be managed inside an administrator's faculty or department scope (`OUT_OF_SCOPE` otherwise).
    - Years, semesters and calendar entries need university-wide scope and `academic_periods.manage`.
  - **Records are deactivated, never deleted.** A parent with active children cannot be deactivated, and nothing can be added or reactivated under an inactive parent.
  - **Semesters:**
    - stay inside their year and never overlap;
    - change dates only while planned;
    - only one can be active, and activating one makes its year current;
    - an active semester closes explicitly.
  - **Calendar entries** stay inside their semester when one is given. Only entries that have not started (Accra date) can be removed, with a reason.
  - Every change is audited with before and after.
  - Database rule violations become clear 409 messages (`CODE_IN_USE`, `PERIOD_OVERLAP`, `ANOTHER_SEMESTER_ACTIVE`, and so on) through `common/db-errors.ts`.
- **Files:**
  - `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261108193558_academic_structure/`.
  - `apps/api/src/modules/academic/*` (access, structure and periods services, controller, module), `apps/api/src/common/db-errors.ts`, `apps/api/src/app.module.ts`.
  - `packages/shared/src/academic.ts`.
  - `apps/api/test/{academic.test.ts, fixtures.ts}`.
  - Docs: API_DOCUMENTATION, DATABASE_SCHEMA.
- **Database changes:**
  - 7 tables.
  - 9 check constraints: upper-case codes, programme duration, date order, semester number.
  - 2 exclusion constraints: years and semesters never overlap.
  - 2 partial unique indexes: one current year, one active semester.
  - Drift check: no difference.
- **Commands run:**
  - `prisma migrate dev`, `db:drift`.
  - A throwaway probe to see how Prisma reports an exclusion-constraint breach (`P2039`, with PostgreSQL code `23P01` inside); deleted after use.
  - `tsc`, `vitest`, `npm run check`.
  - A clean-clone CI rehearsal and the GitHub run (recorded below).
- **Tests run:**
  - `npm run check` exit 0: design-tokens 3, shared 10, API **125** (14 new), web 8, mobile 9, so **155 passed**.
  - Scenario 24 now also covers the 23 new endpoints automatically.
- **Known limitations:**
  - A department cannot be moved to another faculty yet: deactivate it and create a new one. This keeps history simple; a move with audit trail can follow if needed.
  - `user_roles.scope_id` is still not validated against real faculties or departments; that is step 4.
  - There are no dashboard screens for these records yet; that is step 7.
- **Next step:** Phase 2, step 2: campuses, buildings and classrooms.
- **CI:**
  - Clean-clone rehearsal of every CI step: all passed.
  - GitHub run 42517252531 on `89aaf7e`: **success**.

### 2026-11-08 — Phase 2, step 2: places

- **Built:** `campuses`, `buildings` and `classrooms`, with 9 endpoints (see API_DOCUMENTATION, "Places, beacons, devices").
  - Every role may read places (`timetables.read`, because room names are not sensitive). Changes need `classrooms.manage` and university-wide scope, because rooms serve every faculty.
  - Each campus or building can have a geofence (centre and radius in metres, from a site survey); a building's overrides its campus's. `GET /classrooms` returns each room's effective geofence, ready for the Phase 4 location check.
  - Codes are capitalised and unique within their parent. Records are deactivated, never deleted, with the same parent/child rules as step 1. Every change is audited.
- **Files:** `apps/api/prisma/schema.prisma`, `prisma/migrations/20261108200223_places/`, `apps/api/src/modules/places/*`, `apps/api/src/modules/academic/academic.module.ts` (exports the access service), `apps/api/src/app.module.ts`, `packages/shared/src/places.ts`, `apps/api/test/{places.test.ts, fixtures.ts, scenario-24-unauthorised-access.test.ts}`, docs (API_DOCUMENTATION, DATABASE_SCHEMA).
- **Database changes:** 3 tables; checks for capitalised codes, complete and valid geofences (20–5,000 m), and positive capacity. Drift check: no difference.
- **Interruption:** the first `npm run check` was stopped part-way at the product owner's request. Prettier had already reformatted files, which is harmless. No leftover processes were found, and the check was re-run from the start.
- **Problem found and fixed:** the re-run failed 2 scenario-24 tests. Their own assumptions were wrong, not the security: they expected every permission-protected route to refuse students, but viewing rooms is deliberately allowed to every role. The test now checks refusals wherever some role lacks access, and relies on the 401 test for routes every role may use. A repeated mutation check (guard forced open) still makes it fail.
- **Tests run:** `npm run check` exit 0: design-tokens 3, shared 10, API **133** (8 new), web 8, mobile 9, so **163 passed**.
- **Known limitations:** no beacons yet (Phase 4); no map or site-survey tool, so coordinates are typed in; no dashboard screens yet (step 7).
- **Next step:** Phase 2, step 3: courses, course offerings and sections; lecturer profiles; lecturer assignments.
- **CI:**
  - Clean-clone rehearsal of every CI step: all passed.
  - GitHub run 42520162780 on `bfbf030`: **success**.

### 2026-11-08 — Phase 2, step 3: courses and lecturers

- **Built:**
  - Five tables: `courses`, `course_offerings`, `course_sections`, `lecturer_profiles`, `lecturer_assignments`.
  - 17 endpoints, plus `GET /me/teaching` (see API_DOCUMENTATION).
  - **Courses** belong to a department.
  - **Offerings** are a course in one semester, one per course per semester, moving DRAFT → OPEN → CLOSED.
    - Not allowed in a closed semester.
    - A course cannot be deactivated while it has an open offering.
    - A closed offering is frozen.
  - **Sections** are class groups, with optional programme and level hints for Phase 3 clash checks.
  - **Lecturers:**
    - A new email gets a pending account with the Lecturer role and an activation email.
    - An existing account (for example an administrator who also teaches) gets the profile and role added instead of a second account.
    - Staff numbers are stored in capitals and unique, in any reasonable format until D-14.
  - **Assignments:**
    - at most one primary lecturer per section, plus assistants;
    - ending one needs a reason and keeps the record;
    - suspended or inactive lecturers cannot be assigned.
  - Every change is audited through a new shared helper (`common/audit-entry.ts`). Scope comes from the course's or lecturer's department.
- **Bug found and fixed:** a duplicate assignment returned 500 instead of 409.
  - Cause: with the pg driver adapter, Prisma puts the name of a partial unique index in `meta.driverAdapterError.cause.constraint.index`, which `db-errors.ts` did not read. A probe test showed the exact shape; the helper now reads it for every kind of violation.
  - The step 1–3 suites (33 tests) were re-run and pass.
- **Scenario 24:** its exhaustive tests (every endpoint × every role) outgrew Vitest's 5-second default and now have an explicit 60-second limit. They grow with the API by design.
- **Files:**
  - `apps/api/prisma/schema.prisma`, `prisma/migrations/20261108203337_courses_and_lecturers/`.
  - `apps/api/src/modules/courses/*`, `apps/api/src/common/{audit-entry.ts, db-errors.ts}`, `apps/api/src/app.module.ts`.
  - `packages/shared/src/courses.ts`.
  - `apps/api/test/{courses.test.ts, fixtures.ts, scenario-24-unauthorised-access.test.ts}`.
  - Docs: API_DOCUMENTATION, DATABASE_SCHEMA.
- **Database changes:**
  - 5 tables.
  - Checks: capitalised codes and staff numbers, credit hours and capacity ranges, complete assignment endings.
  - Partial unique indexes: one active assignment per lecturer and section; one active primary per section.
  - Drift check: no difference.
- **Tests run:** `npm run check` exit 0: design-tokens 3, shared 10, API **144** (11 new), web 8, mobile 9, so **174 passed**.
- **Known limitations:**
  - Staff-number format not yet enforced (D-14).
  - A lecturer's name and email are edited through their account, not the profile.
  - No dashboard screens yet (step 7).
- **Next step:** Phase 2, step 4: Registrar student registration (manual), and faculty- and department-scoped administrator grants checked against real faculties and departments.
