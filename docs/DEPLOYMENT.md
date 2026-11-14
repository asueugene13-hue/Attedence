# Deployment

AttendSure runs as containers: the API (two or more instances), a worker, the web dashboard, PostgreSQL, Redis and S3-compatible storage. The mobile app ships through the app stores or the university's own distribution. Where production runs is not decided yet (D-16), so this page defines what any host must provide.

**Status:** plan only (2026-11-08). Nothing is deployed.

## 1. Local development (from Phase 1)

Prerequisites on this PC (see SYSTEM_ARCHITECTURE.md §8 for what is already installed):

1. Docker Desktop with the WSL 2 backend.
2. JDK 17 for Android builds, with `JAVA_HOME` pointing at the JDK folder, not its `bin` subfolder.
3. Android Studio with the Android SDK, and `ANDROID_HOME` set.
4. A Firebase project for push notifications. Phase 3 can start with a test project.

`infra/docker-compose.yml` will start:

| Service | Purpose | Local port |
| --- | --- | --- |
| PostgreSQL | Database | 5432 |
| Redis | Queues, rate limits, socket fan-out | 6379 |
| SeaweedFS | S3-compatible file storage (the MinIO image is no longer published) | 8333 |
| Mailpit | Catches outgoing email so nothing reaches real inboxes | 1025 (SMTP), 8025 (web) |

Everyday commands are in the README, under "Getting started (Windows)".

## 2. Environments

| Environment | Purpose | Data |
| --- | --- | --- |
| Local | Development | Obviously fake fixtures only |
| Staging | Testing releases, restore drills, user acceptance testing | Fake data, or an anonymised copy approved by the university |
| Production | Knutsford University | Real data entered by authorised staff |

Fixtures and test accounts are never loaded into production.

## 3. Production requirements (host to be decided, D-16)

| Need | Requirement |
| --- | --- |
| Compute | Containers for `api` (at least 2 instances behind a load balancer with WebSocket support), `worker` (at least 1: `npm run start:worker -w @attendsure/api`, which runs the background jobs and the outbox relay) and `web`. In production leave `RUN_JOBS_IN_API` unset (false), so jobs run only in the worker; `JOB_RETRY_DELAY_MS` (default 5000) sets the first retry wait. |
| PostgreSQL | Version 16 or newer, managed or self-run, with point-in-time recovery, encrypted storage and TLS |
| Redis | Version 7 with append-only persistence, TLS and authentication |
| Object storage | S3-compatible, private buckets, encryption at rest. Settings: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, optional `S3_REGION` and `S3_PUBLIC_ENDPOINT` (the address browsers use for download links). In production the bucket must already exist; the API refuses to start otherwise, and refuses the local example key. |
| TLS | Certificates for the API and dashboard domains, with automatic renewal |
| Secrets | A secret manager, not environment files on disk |
| Monitoring | Structured log collection, metrics (Prometheus format), uptime checks and alerting to on-call staff |
| Location | Agreed with the university's data-protection lead under Act 843. Hosting choices to compare: a cloud region in Africa, a Ghanaian data centre, or university-run servers. |

## 4. First start on a new server

1. Apply migrations: `npm run db:deploy -w @attendsure/api`.
2. Load system roles: `npm run db:seed -w @attendsure/api`.
3. Create the first Super Admin: `npm run admin:create-super-admin -w @attendsure/api -- --email <address> --name "<full name>"`. It prints a single-use activation link (valid 72 h); give it only to that person. The command refuses to run once a Super Admin exists.
4. Set `TRUST_PROXY_HOPS` to the number of load balancers or proxies in front of the API, so rate limits see real client addresses.

## 5. Release process

1. CI runs on every push: lint, type-check, unit and integration tests, a migration check, `npm audit` and a secret scan.
2. The main branch deploys to staging automatically.
3. Production releases are tagged and need manual approval.
4. Database migrations follow expand-then-contract: add new columns or tables first, deploy code that uses them, then remove old ones in a later release. An applied migration is never edited.
5. Mobile builds go through Expo's cloud build service. Releases go out through Google Play and the App Store, or the university's own distribution for a pilot. Over-the-air updates are limited to JavaScript fixes; native changes need a store release.

## 6. Backups and restore drills

| Item | Plan |
| --- | --- |
| Database | Continuous WAL archiving plus a daily encrypted snapshot, kept off-site |
| Files | Object-storage versioning plus a daily replication copy |
| Drill | Monthly restore into staging, timed and recorded in the log below |

| Date | What was restored | Time taken | Result |
| --- | --- | --- | --- |
| — | — | — | No drills yet |

## 7. Containers (Phase 8 step 2)

Three images are built from this repository (always from the repository root):

| Image | Dockerfile | What it runs |
| --- | --- | --- |
| `attendsure-api` | `apps/api/Dockerfile` (target `runtime`) | The API (`node dist/main.js`, port 3000) and, with the command `node dist/worker.js`, the worker |
| `attendsure-api-release` | `apps/api/Dockerfile` (target `migrate`) | The release job: `prisma migrate deploy`, then the system roles. Safe to repeat; it exits when done |
| `attendsure-web` | `apps/web/Dockerfile` | The dashboard (Next.js standalone server, port 3001) |

The images contain no secrets and no `.env` file; every setting comes from the environment when a container starts. They run as the unprivileged `node` user.

`infra/production/compose.yml` describes the production layout:

- **proxy** (Caddy): HTTPS. `/api/*` goes to the two API instances in turn, and moves to the other one if an instance fails its readiness check. The live roster path (`/api/v1/live`) keeps each browser on one instance with a cookie, as Socket.IO requires. `/health/*` and `/metrics` are not served to the outside. Set `SITE_ADDRESS` to the real name and Caddy gets and renews the certificate itself.
- **api-1, api-2**: the API, with `RUN_JOBS_IN_API=false` and `TRUST_PROXY_HOPS=1` (the proxy).
- **worker**: all background jobs (8.1).
- **web**: the dashboard.
- **release**: runs before the API starts.

Settings go in `infra/production/secrets/app.env` (ignored by git). On a real host they come from its secret manager instead. The variables are those in `.env.example`, with `NODE_ENV=production` set by the compose file. In production the API refuses to start with the example secrets, a non-https `WEB_APP_URL`, or a missing bucket.

### Rehearsal on this computer

`infra/production/compose.rehearsal.yml` adds stand-ins for what a host provides: PostgreSQL, Redis, SeaweedFS (S3) and Mailpit. Its data is separate from local development.

1. Make throwaway secrets (once): `node infra/production/make-rehearsal-secrets.mjs`
2. Build and start: `docker compose -f infra/production/compose.yml -f infra/production/compose.rehearsal.yml up -d --build`
3. Create the first Super Admin (prints a one-time activation link; open it in the browser):
   `docker compose -f infra/production/compose.yml -f infra/production/compose.rehearsal.yml run --rm --no-deps api-1 node dist/cli/create-super-admin.js --email <address> --name "<name>"`
4. Open https://localhost:8443. The certificate comes from Caddy's local authority, so the browser warns; accept it for the rehearsal. Emails: http://localhost:8026.
5. Stop: `docker compose -f infra/production/compose.yml -f infra/production/compose.rehearsal.yml down` (add `-v` to delete the rehearsal data too).

### Rehearsal results

| Date | What was checked | Result |
| --- | --- | --- |
| 2026-11-14 | Fresh start with production settings (`NODE_ENV=production`, jobs only in the worker) | All services up and healthy in **22 s**; release job applied every migration and loaded the roles |
| 2026-11-14 | Through https://localhost:8443 in a real browser (Chromium) | First Super Admin activated, two-step sign-in set up, refresh cookie `Secure` and `HttpOnly`; an audit-log file asked for, **made by the worker**, downloaded from the file store; System health: all 8 schedules running, none overdue |
| 2026-11-14 | Routing | `/api/*` shared between api-1 and api-2 (6 and 5 of 11 requests); `/health/*` and `/metrics` not served outside (404); a second `create-super-admin` refused |
| 2026-11-14 | One API instance stopped | 20 of 20 requests still answered by the other instance (no gateway errors) |
