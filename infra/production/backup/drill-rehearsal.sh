#!/usr/bin/env bash
# Backup and restore drill on the production rehearsal (Phase 8 step 5). Run from the repository root
# in Git Bash, with the rehearsal up (DEPLOYMENT.md §7). Times each step and prints a summary.
#
#   bash infra/production/backup/drill-rehearsal.sh
#
# 1. Pauses the API instances and the worker, so the original stays still and the copy can be compared
#    exactly (a real drill restores into staging and is compared with the backup instead).
# 2. Backs up (encrypted), 3. restores into a brand-new, empty database server (a stand-in for a new
#    machine), 4. compares every table, 5. checks the append-only rules survived, 6. starts AttendSure
#    on the restored copy and checks it is ready, then 7. cleans up and resumes the rehearsal.
set -euo pipefail
export MSYS_NO_PATHCONV=1

here="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
root="$(cd "$(dirname "$0")/../../.." && (pwd -W 2>/dev/null || pwd))"
secrets="$root/infra/production/secrets"
[ -f "$secrets/rehearsal.env" ] || { echo "Run make-rehearsal-secrets.mjs and start the rehearsal first." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . "$secrets/rehearsal.env"; set +a
mkdir -p "$secrets/backups"
pass="$secrets/backup-passphrase"
[ -s "$pass" ] || node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > "$pass"

win() { (cd "$1" && pwd -W 2>/dev/null || pwd); }
compose=(docker compose -f "$root/infra/production/compose.yml" -f "$root/infra/production/compose.rehearsal.yml")
network="attendsure-production_default"
pg_image="postgres:18.6"
restore_db="attendsure-restore-drill-db"
restore_api="attendsure-restore-drill-api"
src_url="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB"
dst_url="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$restore_db:5432/$POSTGRES_DB"
tools=(docker run --rm --network "$network" -v "$here:/drill:ro" -v "$(win "$secrets/backups"):/backups"
  -v "$(win "$secrets"):/secrets:ro" -e BACKUP_PASSPHRASE_FILE=/secrets/backup-passphrase
  -e PGUSER="$POSTGRES_USER" -e PGPASSWORD="$POSTGRES_PASSWORD" -e PGDATABASE="$POSTGRES_DB" "$pg_image")

cleanup() { docker rm -f "$restore_db" "$restore_api" >/dev/null 2>&1 || true; }
trap 'cleanup; "${compose[@]}" start api-1 api-2 worker >/dev/null 2>&1 || true' EXIT
cleanup

t() { date +%s; }
drill_start=$(t)

echo "1. Pausing the API instances and the worker."
"${compose[@]}" stop api-1 api-2 worker >/dev/null 2>&1

echo "2. Backing up (encrypted)."
s=$(t)
file="$("${tools[@]}" env PGHOST=postgres bash /drill/backup.sh | tail -1)"
backup_s=$(( $(t) - s ))
size="$(du -h "$secrets/backups/$file" | cut -f1)"
echo "   $file ($size) in ${backup_s}s"

echo "3. Restoring into a brand-new, empty database server."
s=$(t)
docker run -d --name "$restore_db" --network "$network" -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -e POSTGRES_DB="$POSTGRES_DB" "$pg_image" >/dev/null
until docker exec "$restore_db" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h 127.0.0.1 >/dev/null 2>&1; do sleep 1; done
"${tools[@]}" env PGHOST="$restore_db" bash /drill/restore.sh "$file"
restore_s=$(( $(t) - s ))
echo "   restored in ${restore_s}s (including starting the new server)"

echo "4. Comparing every table with the original."
s=$(t)
"${tools[@]}" bash /drill/compare.sh "$src_url" "$dst_url"
compare_s=$(( $(t) - s ))

echo "5. Checking the history tables are still append-only on the copy."
if "${tools[@]}" psql "$dst_url" -v ON_ERROR_STOP=1 -qc \
  "update audit_logs set action = action where id = (select id from audit_logs limit 1)" >/dev/null 2>&1; then
  echo "   FAILED: the audit log could be changed on the restored copy." >&2
  exit 1
fi
echo "   the audit log refused a change, as it should"

echo "6. Starting AttendSure on the restored copy."
s=$(t)
docker run --rm --network "$network" --env-file "$secrets/app.env" -e NODE_ENV=production \
  -e DATABASE_URL="$dst_url" attendsure-api-release:local 2>&1 | grep -E "No pending migrations|migrations have been applied" | sed 's/^/   /'
docker run -d --name "$restore_api" --network "$network" --env-file "$secrets/app.env" -e NODE_ENV=production \
  -e DATABASE_URL="$dst_url" -e RUN_JOBS_IN_API=false attendsure-api:local >/dev/null
ready=no
for _ in $(seq 1 60); do
  if docker exec "$restore_api" node -e \
    "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    ready=yes; break
  fi
  sleep 1
done
[ "$ready" = yes ] || { echo "   FAILED: the API on the restored copy did not become ready." >&2; docker logs --tail 20 "$restore_api" >&2; exit 1; }
start_s=$(( $(t) - s ))
echo "   ready in ${start_s}s"

total_s=$(( $(t) - drill_start ))
echo
echo "Drill passed. Backup ${backup_s}s, restore ${restore_s}s, compare ${compare_s}s, start on the copy ${start_s}s; ${total_s}s in all (backup $size)."
echo "7. Cleaning up and resuming the rehearsal."
