#!/usr/bin/env bash
# AttendSure database backup (Phase 8 step 5): a full dump, encrypted, with a checksum.
#
# Runs where pg_dump and gpg exist (the postgres:18.6 image has both). Settings:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE   the database to back up
#   BACKUP_PASSPHRASE_FILE                            file holding the encryption passphrase (from the secret manager)
#   BACKUP_DIR                                        where to write (default /backups)
# Writes attendsure-<UTC time>.dump.gpg and a .sha256 next to it, and prints the file name.
# The passphrase and ENCRYPTION_KEY (which protects some columns inside the dump) must be kept
# separately from the backups: without both, a backup cannot be used (DEPLOYMENT.md §6).
set -euo pipefail

: "${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE}"
dir="${BACKUP_DIR:-/backups}"
[ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "The passphrase file is empty or missing." >&2; exit 1; }
mkdir -p "$dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/attendsure-$stamp.dump.gpg"
export GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME" "$out.partial"' EXIT

# --format=custom: compressed, and pg_restore can check it and restore it in parallel.
# pipefail: if pg_dump fails, the whole backup fails (no half-written file is kept).
pg_dump --format=custom --no-owner --no-privileges \
  | gpg --batch --yes --quiet --pinentry-mode loopback --symmetric --cipher-algo AES256 \
      --passphrase-file "$BACKUP_PASSPHRASE_FILE" --output "$out.partial"
mv "$out.partial" "$out"
(cd "$dir" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
echo "$(basename "$out")"
