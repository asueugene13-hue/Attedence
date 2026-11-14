#!/usr/bin/env bash
# AttendSure database restore (Phase 8 step 5) into an EMPTY database.
#
#   restore.sh <backup file name in BACKUP_DIR>
# Settings: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (the empty target), BACKUP_PASSPHRASE_FILE,
# BACKUP_DIR (default /backups).
# It refuses a database that already has tables: a restore never overwrites data silently. To replace a
# damaged database, restore into a new one, check it, then point AttendSure at it (DEPLOYMENT.md §6).
set -euo pipefail

file="${1:?usage: restore.sh <backup file name>}"
: "${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE}"
dir="${BACKUP_DIR:-/backups}"
cd "$dir"

# 1. The file is the one that was written (checksum), before anything is decrypted.
sha256sum --check --quiet "$file.sha256"

# 2. The target is empty.
tables="$(psql -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [ "$tables" != "0" ]; then
  echo "Refusing: database $PGDATABASE already has $tables tables. Restore into an empty database." >&2
  exit 1
fi

# 3. Decrypt (gpg also checks the file was not altered) and restore; stop at the first error.
export GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$BACKUP_PASSPHRASE_FILE" "$file" \
  | pg_restore --exit-on-error --no-owner --no-privileges --dbname "$PGDATABASE"
echo "Restored $file into $PGDATABASE."
