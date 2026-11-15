# Operations runbook

**For:** the people who run AttendSure's servers at Knutsford University (IT), and whoever is on call.
**Assumes:** the container layout in [DEPLOYMENT.md](DEPLOYMENT.md) §7 (proxy, two API instances, worker, dashboard, release job) on the host chosen under D-16. Commands are written for Docker Compose with `infra/production/compose.yml`; on another platform, use its equivalent. Below, `dc` means `docker compose -f infra/production/compose.yml`.

## 1. What runs where

| Part | Does | If it stops |
| --- | --- | --- |
| proxy (Caddy) | HTTPS, sends `/api` to the API instances and the rest to the dashboard | Nobody can reach AttendSure |
| api-1, api-2 | Every request from phones and the dashboard; live rosters | One stopped: the other carries on (load-tested, DEPLOYMENT.md §8). Both stopped: nobody can check in |
| worker | Background jobs: closing attendance and marking absences, class monitoring, emails, reports, clean-ups | Requests still work, but attendance does not close by itself, alerts and emails stop, report files are not made. System health shows schedules as **Overdue** |
| web | The dashboard pages | Staff cannot use the dashboard; phones still work |
| PostgreSQL | All records | Everything stops (the API's readiness check fails) |
| Redis | Queues, rate limits, live-roster messages, the one-time numbers that stop replayed requests | Everything stops (the readiness check fails) |
| Object storage | Photos, attachments, report files | Uploads, photos and downloads fail; attendance still works |

**Health checks:** `/health/live` (the process runs) and `/health/ready` (the database and Redis answer), inside the network only. **Metrics:** `/metrics` with the `METRICS_TOKEN`, inside the network only (SECURITY.md §9). **Logs:** each container writes one JSON line per event to standard output; every request line carries a `requestId`, and every error reply from the API includes the same `requestId`. When the server fails (a 5xx error), the dashboard and the phone app show it as "(reference …)" at the end of the message: ask the person for it and search the logs for it.

## 2. First deployment

1. Settings into the secret manager (the variables in `.env.example`, with real values): new random `JWT_ACCESS_SECRET` and `ENCRYPTION_KEY` (commands in `.env.example`), `WEB_APP_URL=https://<the name>`, the database, Redis, storage and email details, `TRUST_PROXY_HOPS` (1 behind this proxy, more behind extra load balancers), `METRICS_TOKEN` if metrics are collected. Keep a copy of `ENCRYPTION_KEY` and the backup passphrase somewhere safe and separate: without them backups cannot be used.
2. Build the images for the release (`dc build`, with `FILES_ORIGIN` set to the storage service's public address) and tag them with the release version (`ATTENDSURE_VERSION`).
3. `dc up -d`. The release job applies the migrations and loads the roles first; the API instances start only if it succeeded.
4. Create the first Super Admin: `dc run --rm --no-deps api-1 node dist/cli/create-super-admin.js --email <address> --name "<full name>"`. Give the printed link only to that person.
5. Check: the site opens over HTTPS; sign in; System health shows every schedule **Running** within a few minutes.

## 3. Releasing a new version

1. CI must have passed on the commit (tests, image builds, secret scan).
2. Back up the database (§6) and note the file name.
3. Set `ATTENDSURE_VERSION` to the new tag, `dc build`, then `dc up -d`. The release job runs first; then each service is replaced.
4. Check as in §2 step 5, plus one check-in in a test class if one is running.
5. Write down the version, time and who did it.

**Rolling back:** set `ATTENDSURE_VERSION` back to the previous tag and `dc up -d`. Migrations only ever add to the database first and remove things in a later release (expand-then-contract, DEPLOYMENT.md §5), so the previous version works with the newer database. Never edit or delete an applied migration. Restoring the backup from step 2 is a last resort: it loses everything written since.

## 4. Everyday checks

| How often | Check |
| --- | --- |
| Daily | System health: no **Overdue** schedules, no unacknowledged problems. Backups ran and were copied off-site |
| Weekly | Disk space for the database and backups; certificate valid for more than 2 weeks (Caddy renews it by itself); Beacons page for beacons suspected faulty |
| Monthly | Restore drill into staging, recorded in DEPLOYMENT.md §6 |
| Each semester | Update the operating system and images; review who holds Super Admin and administrator roles |

## 5. When something goes wrong

| What people see | First check | Then |
| --- | --- | --- |
| The site does not open | `dc ps`: is the proxy up? Certificate errors in `dc logs proxy`? | Restart the proxy (`dc restart proxy`). A certificate problem usually means the name no longer points at the server |
| "Something went wrong" or 502 for everyone | `dc ps`: are api-1 and api-2 healthy? `dc logs --tail 100 api-1` | Unhealthy means the database or Redis is not answering: check those first. Restart one instance at a time, never both at once |
| Phones' check-ins all refused in one room | Beacons page and System health (beacon suspected faulty) | Use degraded mode or lecturer-assisted check-in for that class (ATTENDANCE_FLOW.md); replace the beacon's battery |
| Attendance does not close by itself; alerts or emails stop; report files stay "Waiting" | System health: schedules **Overdue**? `dc ps worker` | Start or restart the worker (`dc up -d worker`). It catches up by itself; nothing is lost while it is down, it is only late |
| Emails not arriving | System health problems; `dc logs worker` for mail errors | Check the email service's account and limits (D-17). Emails are retried; the in-app notifications are the record |
| Photos or downloads fail | Storage service status; `S3_PUBLIC_ENDPOINT` | Attendance is unaffected; fix the storage service |
| Database lost or damaged | | Follow DEPLOYMENT.md §9 "To recover": restore the latest backup into a new database, run the release job, point `DATABASE_URL` at it, start the API and worker |
| One person's account misused | Audit log, filtered to that person | Suspend the account (Accounts, with a reason): it signs them out everywhere. Ask them to reset their password; re-issue two-step sign-in if needed |
| Suspected leak of `JWT_ACCESS_SECRET` | | Replace it in the secret manager and restart the API instances: everyone must sign in again. Treat `ENCRYPTION_KEY` as needing a planned procedure (not built yet): ask the developers before changing it |

Every incident: note when it started, what was seen, what was done and when it ended; tell the university's data protection lead if personal data may have been exposed (Act 843).

## 6. Backups

`infra/production/backup/backup.sh` daily (encrypted, with a checksum), copied off-site, plus the host's continuous WAL archiving if it offers it; files rely on the storage service's versioning (DEPLOYMENT.md §9). Restores go into an empty database only (`restore.sh` refuses anything else), and the comparison script checks the result.

## 7. Who to call

| For | Name and contact (to be filled in by the university) |
| --- | --- |
| Servers and network | |
| AttendSure application | |
| Data protection lead | |
| Registry (student records) | |
| Academic administration | |
