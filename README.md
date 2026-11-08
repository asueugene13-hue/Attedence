# AttendSure

Attendance management and classroom-presence verification for Knutsford University, Accra, Ghana.

**Status (2026-11-08): Phase 0, architecture and planning. No application code exists yet.** Phase 1 starts only after the product owner approves the plan and settles the decisions marked "before Phase 1" in [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md).

## What it does

- **Watches every scheduled class.** The published timetable becomes concrete class sessions before they happen. If a lecturer has not started 15 minutes after the scheduled time, AttendSure asks them what is happening, collects reports from students and course reps, and escalates to an administrator. It never cancels a class by itself.
- **Confirms attendance only for students in the room.** The server checks four things together: a QR code that changes every 15 seconds, the classroom's Bluetooth beacon, a supporting GPS reading and the student's trusted phone. A QR scan alone never confirms attendance.
- **Gives six roles their own tools.** Super Admin, University Administrator, Registrar, Lecturer, Student and Course Representative. The server limits each role to what it may see and do.

## Planned stack

| Part | Technology |
| --- | --- |
| Mobile app (students, lecturers, course reps) | React Native, TypeScript, Expo development builds (pending decision D-01) |
| Web dashboard (staff roles, lecturer live roster) | Next.js, TypeScript |
| API and background worker | NestJS, TypeScript, REST, Socket.IO, BullMQ |
| Database | PostgreSQL with Prisma |
| Supporting services | Redis, S3-compatible file storage, Firebase Cloud Messaging, email, optional SMS, Docker |

## Documents

| Document | What it answers |
| --- | --- |
| [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) | Where the project stands, open decisions, phase plan. Read first. |
| [docs/SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) | How the parts fit, folder structure, modules, dependencies, technical risks |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | Every table, key, constraint, index and retention rule |
| [docs/ER_DIAGRAM.md](docs/ER_DIAGRAM.md) | Entity-relationship diagrams by domain |
| [docs/ROLE_PERMISSION_MATRIX.md](docs/ROLE_PERMISSION_MATRIX.md) | Who can do what, and how the server enforces it |
| [docs/CLASS_LIFECYCLE.md](docs/CLASS_LIFECYCLE.md) | From timetable to class session; the 11 class statuses and their transitions |
| [docs/CLASS_MONITORING.md](docs/CLASS_MONITORING.md) | How possible cancellations are detected and escalated |
| [docs/PRESENCE_VERIFICATION.md](docs/PRESENCE_VERIFICATION.md) | QR, BLE, GPS and device evidence, and the decision rules |
| [docs/ATTENDANCE_FLOW.md](docs/ATTENDANCE_FLOW.md) | Starting a class, checking in, live roster, attendance calculation |
| [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) | REST endpoints and WebSocket events (design draft) |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication, authorisation, privacy under Act 843, threats |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy and the 25 required scenarios |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local setup, environments, production plan, backups |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | What the system cannot guarantee |

**UI designs:** the [AttendSure UI — Knutsford University](https://claude.ai/artifact/QA6eYPCN51FNpWASQbgLUV) design canvas holds the design system, the information architecture, Student Home, the check-in flow and the lecturer live roster. Every name, course and number on it is sample layout data, not a Knutsford record.

## Repository layout (planned)

```
apps/api                 NestJS API and background worker
apps/web                 Next.js dashboard
apps/mobile              React Native app
packages/shared          Zod schemas, enums, permission keys, status rules shared by all apps
packages/design-tokens   colours, type and spacing from the design system
infra/                   local Docker services (PostgreSQL, Redis, SeaweedFS, Mailpit)
docs/                    design documents
```

## Getting started (Windows)

What works today: the shared package, its tests and the checks. The API, web and mobile apps arrive in later Phase 1 steps.

1. Install Node.js 24 (already on this PC) and run `npm install` in this folder.
2. Run `npm run check`. It formats-checks, lints, type-checks, builds and tests everything.

To run the local database and services (needed from the API step onwards):

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and choose the WSL 2 backend when asked. Restart if prompted.
2. Copy the example settings: `copy .env.example .env` (PowerShell: `Copy-Item .env.example .env`).
3. Run `npm run infra:up`. This starts PostgreSQL, Redis, SeaweedFS (S3 file storage) and Mailpit. Open http://localhost:8025 to see emails the system sends.
4. Run `npm run infra:down` to stop them. Your data stays in Docker volumes.

| Command | What it does |
| --- | --- |
| `npm run check` | Everything CI runs, except the dependency audit |
| `npm test` | Tests only |
| `npm run lint` · `npm run format` | Find code problems · fix formatting |
| `npm run infra:up` · `infra:down` · `infra:logs` | Start, stop, watch local services |
