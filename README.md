# AttendSure

Attendance management and classroom-presence verification for Knutsford University, Accra, Ghana.

**Status (2026-11-08): Phase 1, foundation, in progress.** The repository foundation and the API skeleton are built. Progress, open decisions and the next step are in [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md).

## What it does

- **Watches every scheduled class.** The published timetable becomes concrete class sessions before they happen. If a lecturer has not started 15 minutes after the scheduled time, AttendSure asks them what is happening, collects reports from students and course reps, and escalates to an administrator. It never cancels a class by itself.
- **Confirms attendance only for students in the room.** The server checks four things together: a QR code that changes every 15 seconds, the classroom's Bluetooth beacon, a supporting GPS reading and the student's trusted phone. A QR scan alone never confirms attendance.
- **Gives six roles their own tools.** Super Admin, University Administrator, Registrar, Lecturer, Student and Course Representative. The server limits each role to what it may see and do.

## Planned stack

| Part | Technology |
| --- | --- |
| Mobile app (students, lecturers, course reps) | React Native, TypeScript, Expo development builds |
| Web dashboard (staff roles, lecturer live roster) | Next.js, TypeScript |
| API and background worker | NestJS 12, TypeScript, REST, Socket.IO, BullMQ |
| Database | PostgreSQL 18 with Prisma 7 |
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

## Repository layout

```
apps/api                 NestJS API and background worker (built: skeleton with health checks)
apps/web                 Next.js dashboard (Phase 1, step 7)
apps/mobile              React Native app (Phase 1, step 8)
packages/shared          Role keys, permission catalogue and rules shared by all apps
packages/design-tokens   Colours, type and spacing from the design system (Phase 1, step 7)
infra/                   Local Docker services (PostgreSQL, Redis, SeaweedFS, Mailpit)
docs/                    Design documents
```

## Getting started (Windows)

**One-time setup**

1. Install Node.js 24 and [Docker Desktop](https://www.docker.com/products/docker-desktop/) (WSL 2 backend). Both are already on this PC.
2. In this folder, run `npm install`.
3. Copy the example settings: `Copy-Item .env.example .env` in PowerShell, or `copy .env.example .env` in Command Prompt. The values in it are for your own computer only.

**Every day**

1. Open Docker Desktop and wait for "Engine running".
2. `npm run infra:up` starts PostgreSQL, Redis, SeaweedFS (file storage) and Mailpit (catches emails; open http://localhost:8025).
3. `npm run dev -w @attendsure/api` starts the API at http://localhost:3000 and restarts it when code changes. Check http://localhost:3000/health/ready: it should say `"status":"ok"`.
4. `npm run infra:down` stops the services when you are done. Your data stays in Docker volumes.

| Command | What it does |
| --- | --- |
| `npm run check` | Everything CI runs except the dependency audit: format check, lint, type-check, build, tests. Needs the Docker services running. |
| `npm test` | Tests only (also needs the Docker services) |
| `npm run lint` · `npm run format` | Find code problems · fix formatting |
| `npm run infra:up` · `infra:down` · `infra:logs` | Start, stop, watch local services |
| `npm run dev -w @attendsure/api` | API in development mode |
| `npm run db:migrate -w @attendsure/api` | Apply new database migrations (development) |
| `npm run build -w @attendsure/api`, then `npm run db:seed -w @attendsure/api` | Load the system roles and permissions (safe to repeat) |
| `npm run build -w @attendsure/api`, then `npm run start -w @attendsure/api` or `npm run start:worker -w @attendsure/api` | Built API or worker, as production runs them |
