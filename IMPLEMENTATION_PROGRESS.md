# Implementation progress

Read this first in every session, and update it after every implementation step.

**Current phase:** Phase 1, foundation. Step 1 (repository foundation) is done; step 2 (API skeleton) is next.
**Last updated:** 2026-11-08

### Phase 1 steps

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Repository foundation: npm workspaces, TypeScript, lint, format, tests, CI, local Docker services, shared role and permission catalogue | Done (2026-11-08) |
| 2 | API skeleton: NestJS app and worker entry points, validated config, structured logging, health checks, Prisma connection | Not started; needs Docker Desktop installed |
| 3 | Identity schema and migrations: users, roles, permissions, grants, sessions, tokens, devices, audit log (+ append-only trigger) | Not started |
| 4 | Authentication: activation, login, refresh rotation with reuse detection, logout, password reset, lockout, TOTP for staff | Not started |
| 5 | Authorisation: permission guard, scope policies, role switch, audit interceptor; Super Admin bootstrap command | Not started |
| 6 | Super Admin API: users, role grants, role permissions, settings, audit-log search | Not started |
| 7 | Web shell: Next.js, design tokens, login, MFA, role-aware sidebar, Super Admin screens | Not started |
| 8 | Mobile shell: Expo development build, login, secure token storage, role-based navigation | Not started; needs JDK 17 and Android Studio |
| 9 | Phase 1 exit: auth and RBAC test suite green in CI; scenario 24 covered for every Phase 1 endpoint | Not started |

## Phase status

| Phase | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| 0 Inspection and architecture | Design documents in `docs/` | Product owner approves; D-01 to D-07 decided | Done, approved 2026-11-08 |
| 1 Foundation | Monorepo, local services, API/web/mobile shells, database, sign-in, refresh tokens, MFA, roles and permissions, Super Admin tools, audit log, CI | Auth and RBAC tests pass in CI; first Super Admin created with a one-time command, not a seeded password | In progress (step 1 of 9 done) |
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
