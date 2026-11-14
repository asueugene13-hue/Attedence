#!/usr/bin/env bash
# Compares two AttendSure databases table by table (Phase 8 step 5, restore drills):
# the row count and a fingerprint (md5) of every row's full contents, for every table.
#
#   compare.sh <source connection URL> <restored connection URL>
# Prints one line per table that differs, then a summary; exits 1 if any table differs.
set -euo pipefail
src="${1:?source URL}"
dst="${2:?restored URL}"

query="
select string_agg(format(
  'select %L, count(*), coalesce(md5(string_agg(t::text, %L order by t::text)), %L) from %I t',
  table_name, E'\\n', 'empty', table_name), ' union all ' order by table_name)
from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"

fingerprint() {
  local sql
  sql="$(psql "$1" -Atc "$query")"
  psql "$1" -At -F ' ' -c "$sql" | sort
}

a="$(fingerprint "$src")"
b="$(fingerprint "$dst")"
tables="$(printf '%s\n' "$a" | wc -l)"
rows="$(printf '%s\n' "$a" | awk '{ s += $2 } END { print s }')"
if [ "$a" = "$b" ]; then
  echo "Identical: $tables tables, $rows rows, every row's contents the same."
else
  echo "DIFFERENT:"
  diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") || true
  exit 1
fi
