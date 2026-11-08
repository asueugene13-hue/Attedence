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

Step-by-step commands are added to README.md when Phase 1 creates these files.

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
| Compute | Containers for `api` (at least 2 instances behind a load balancer with WebSocket support), `worker` (at least 1) and `web` |
| PostgreSQL | Version 16 or newer, managed or self-run, with point-in-time recovery, encrypted storage and TLS |
| Redis | Version 7 with append-only persistence, TLS and authentication |
| Object storage | S3-compatible, private buckets, encryption at rest |
| TLS | Certificates for the API and dashboard domains, with automatic renewal |
| Secrets | A secret manager, not environment files on disk |
| Monitoring | Structured log collection, metrics (Prometheus format), uptime checks and alerting to on-call staff |
| Location | Agreed with the university's data-protection lead under Act 843. Hosting choices to compare: a cloud region in Africa, a Ghanaian data centre, or university-run servers. |

## 4. Release process

1. CI runs on every push: lint, type-check, unit and integration tests, a migration check, `npm audit` and a secret scan.
2. The main branch deploys to staging automatically.
3. Production releases are tagged and need manual approval.
4. Database migrations follow expand-then-contract: add new columns or tables first, deploy code that uses them, then remove old ones in a later release. An applied migration is never edited.
5. Mobile builds go through Expo's cloud build service. Releases go out through Google Play and the App Store, or the university's own distribution for a pilot. Over-the-air updates are limited to JavaScript fixes; native changes need a store release.

## 5. Backups and restore drills

| Item | Plan |
| --- | --- |
| Database | Continuous WAL archiving plus a daily encrypted snapshot, kept off-site |
| Files | Object-storage versioning plus a daily replication copy |
| Drill | Monthly restore into staging, timed and recorded in the log below |

| Date | What was restored | Time taken | Result |
| --- | --- | --- | --- |
| — | — | — | No drills yet |
