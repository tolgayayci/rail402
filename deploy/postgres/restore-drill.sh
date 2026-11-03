#!/usr/bin/env bash
# A point-in-time restore drill with the backup image (deploy/postgres/Dockerfile), on throwaway
# containers and volumes: nothing outside them is read or written.
#
#   deploy/postgres/restore-drill.sh            prints one JSON document on stdout
#
# 1. starts Postgres with continuous WAL archiving to an encrypted pgBackRest repository; pgBackRest
#    reads its settings, the cipher passphrase included, from a mode-0400 file (as a file secret would
#    deliver it), never from the environment or a command line;
# 2. creates the owner and runtime roles with roles.sql, applies every Rail402 migration as the owner and
#    writes rows, one of them carrying a random marker;
# 3. takes a full backup and reads the archive and backup metrics (backup-metrics.sh), writes more rows,
#    notes the target time and the table checksums at that time, then writes rows that must not survive;
# 4. searches the repository for the marker (it must not be there: the backup is encrypted) and the
#    data directory (it must be there, so the search would have found it);
# 5. stops that server, restores into an empty data volume to the target time, starts it, compares row
#    counts and checksums with the ones noted at the target, and checks that the runtime role can still
#    read and write rows, and still cannot create a table.
# Exit 0 only when every check holds.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
id="drill-$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
image="rail402-postgres:$id"
data="$id-data"
restored="$id-restored"
repo="$id-repo"
spool="$id-spool"
conf="$id-conf"
textfile="$(mktemp -d)"
cipher="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
marker="rail402-drill-marker-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
log() { printf '==> %s\n' "$*" >&2; }

cleanup() {
  docker rm -f "$id-a" "$id-b" >/dev/null 2>&1 || true
  docker volume rm -f "$data" "$restored" "$repo" "$spool" "$conf" >/dev/null 2>&1 || true
  docker image rm -f "$image" >/dev/null 2>&1 || true
  rm -rf "$textfile"
}
trap cleanup EXIT

env_args=(-e POSTGRES_PASSWORD=drill -e PGBACKREST_CONFIG=/run/secrets/pgbackrest.conf)
archive_args=(-c wal_level=replica -c archive_mode=on -c archive_timeout=60
  -c "archive_command=pgbackrest --stanza=rail402 archive-push %p")
volume_args() { # data volume
  printf '%s\n' -v "$1:/var/lib/postgresql" -v "$repo:/var/lib/pgbackrest" \
    -v "$spool:/var/spool/pgbackrest" -v "$conf:/run/secrets:ro"
}

start_server() { # name volume
  local volumes
  mapfile -t volumes < <(volume_args "$2")
  docker run -d --name "$1" --network none "${env_args[@]}" "${volumes[@]}" \
    -v "$root/packages/store-postgres/migrations:/migrations:ro" \
    -v "$root/deploy/postgres:/share:ro" \
    "$image" postgres "${archive_args[@]}" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$1" pg_isready -q -U postgres 2>/dev/null && return 0
    sleep 1
  done
  docker logs "$1" >&2
  return 1
}
# psql in a server container, as a role on a database.
psql_as() { # container role database sql
  docker exec -i "$1" psql -X -q -U "$2" -d "$3" -v ON_ERROR_STOP=1 -tA -c "$4"
}
sql() { psql_as "$1" postgres rail402 "$2"; }
# Row counts and an order-independent checksum of every table in public.
fingerprint() {
  sql "$1" "SELECT json_object_agg(t.tablename, (xpath('/row/c/text()', query_to_xml(format(
    'SELECT count(*) || '':'' || coalesce(md5(string_agg(md5(x::text), '''' ORDER BY md5(x::text))), '''') AS c FROM public.%I x',
    t.tablename), false, true, '')))[1]::text ORDER BY t.tablename) FROM pg_tables t WHERE t.schemaname = 'public'"
}

log "building the backup image"
docker build -q -t "$image" "$root/deploy/postgres" >/dev/null
for volume in "$data" "$restored" "$repo" "$spool" "$conf"; do docker volume create "$volume" >/dev/null; done
# The repository, spool and restore volumes belong to the postgres user (uid 70 in the Alpine image).
# pgBackRest's settings arrive on standard input and land in a file only that user can read.
docker run --rm -i -u 0 -v "$repo:/r" -v "$spool:/s" -v "$restored:/d" -v "$conf:/c" "$image" sh -c '
  chown 70:70 /r /s /d
  cat >/c/pgbackrest.conf && chown 70:70 /c/pgbackrest.conf && chmod 0400 /c/pgbackrest.conf' <<CONF
[global]
repo1-path=/var/lib/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$cipher
archive-async=y
spool-path=/var/spool/pgbackrest
start-fast=y
log-level-console=warn

[rail402]
pg1-path=/var/lib/postgresql/18/docker
CONF

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "starting Postgres with WAL archiving"
start_server "$id-a" "$data"
psql_as "$id-a" postgres postgres "CREATE DATABASE rail402" >/dev/null
docker exec -i "$id-a" psql -X -q -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
\set owner rail402_owner
\set app rail402_app
\set database rail402
\set app_connection_limit 10
\set owner_password '$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')'
\set app_password '$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')'
\i /share/roles.sql
\i /share/grants.sql
SQL
docker exec "$id-a" pgbackrest --stanza=rail402 stanza-create >/dev/null
for file in "$root"/packages/store-postgres/migrations/*.sql; do
  docker exec "$id-a" psql -X -q -U rail402_owner -d rail402 -v ON_ERROR_STOP=1 -f "/migrations/$(basename "$file")" >/dev/null
done
psql_as "$id-a" rail402_owner rail402 "CREATE TABLE drill_rows (id bigint PRIMARY KEY, phase text NOT NULL, payload text NOT NULL)"
# After migrations, as a deploy does: the runtime role's privileges on what they created.
docker exec -i "$id-a" psql -X -q -U postgres -d rail402 -v ON_ERROR_STOP=1 >/dev/null <<SQL
\set owner rail402_owner
\set app rail402_app
\i /share/grants.sql
SQL
psql_as "$id-a" rail402_app rail402 "INSERT INTO drill_rows SELECT g, 'before-backup', md5(g::text) FROM generate_series(1, 1000) g"
psql_as "$id-a" rail402_app rail402 "INSERT INTO drill_rows VALUES (0, 'marker', '$marker')"

log "taking a full backup"
backup_started="$(date +%s)"
docker exec "$id-a" pgbackrest --stanza=rail402 backup --type=full >/dev/null
backup_seconds=$(($(date +%s) - backup_started))
label="$(docker exec "$id-a" pgbackrest info --output=json | sed -n 's/.*"label":"\([^"]*\)".*/\1/p' | tail -1)"
PG_EXEC="docker exec -i $id-a" "$root/deploy/postgres/backup-metrics.sh" "$textfile"
metric() { sed -n "s/^$1 \\([0-9]*\\)$/\\1/p" "$textfile/rail402_backup.prom"; }
archived="$(metric rail402_wal_archived_total)"
archive_failures="$(metric rail402_wal_archive_failures_total)"
full_backup_at="$(metric 'rail402_backup_last_completed_timestamp_seconds{type="full"}')"

psql_as "$id-a" rail402_app rail402 "INSERT INTO drill_rows SELECT g, 'after-backup', md5(g::text) FROM generate_series(1001, 1500) g"
sql "$id-a" "SELECT pg_switch_wal()" >/dev/null
sleep 2
target="$(sql "$id-a" "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
expected="$(fingerprint "$id-a")"
sleep 2
psql_as "$id-a" rail402_app rail402 "INSERT INTO drill_rows SELECT g, 'after-target', md5(g::text) FROM generate_series(1501, 1800) g"
sql "$id-a" "SELECT pg_switch_wal()" >/dev/null
docker exec "$id-a" pgbackrest --stanza=rail402 check >/dev/null
docker exec "$id-a" psql -X -q -U postgres -d postgres -c CHECKPOINT >/dev/null
docker stop -t 30 "$id-a" >/dev/null

# The marker row is in the data files in clear text; the repository must hold it only encrypted.
in_data=false
in_repo=false
docker run --rm -v "$data:/d:ro" "$image" grep -rqa "$marker" /d && in_data=true
docker run --rm -v "$repo:/r:ro" "$image" grep -rqa "$marker" /r && in_repo=true

log "restoring into an empty data volume to $target"
restore_started="$(date +%s)"
mapfile -t volumes < <(volume_args "$restored")
docker run --rm --network none "${env_args[@]}" "${volumes[@]}" "$image" \
  sh -c 'install -d -m 700 /var/lib/postgresql/18/docker && pgbackrest --stanza=rail402 restore --type=time --target="$0" --target-action=promote' \
  "$target" >/dev/null
start_server "$id-b" "$restored"
for _ in $(seq 1 60); do
  [[ "$(sql "$id-b" "SELECT pg_is_in_recovery()")" == f ]] && break
  sleep 1
done
restore_seconds=$(($(date +%s) - restore_started))
actual="$(fingerprint "$id-b")"
after_target="$(sql "$id-b" "SELECT count(*) FROM drill_rows WHERE phase = 'after-target'")"
tables="$(sql "$id-b" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
version="$(docker exec "$id-b" pgbackrest version)"

# The runtime role after the restore: reads and writes rows, and still has no DDL.
app_reads=false
app_writes=false
app_ddl_refused=false
[[ "$(psql_as "$id-b" rail402_app rail402 "SELECT count(*) FROM settlements" 2>/dev/null)" =~ ^[0-9]+$ ]] && app_reads=true
psql_as "$id-b" rail402_app rail402 "INSERT INTO drill_rows VALUES (9999, 'after-restore', 'x'); DELETE FROM drill_rows WHERE id = 9999" >/dev/null 2>&1 && app_writes=true
psql_as "$id-b" rail402_app rail402 "CREATE TABLE drill_ddl (id int)" >/dev/null 2>&1 || app_ddl_refused=true
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

matches=false
[[ "$actual" == "$expected" && "$after_target" == 0 ]] && matches=true
metrics_ok=false
[[ "${archived:-0}" -gt 0 && "${archive_failures:-1}" == 0 && "${full_backup_at:-0}" -ge "$backup_started" ]] && metrics_ok=true
ok=false
$matches && $app_reads && $app_writes && $app_ddl_refused && $metrics_ok && $in_data && ! $in_repo && ok=true
cat <<JSON
{"startedAt":"$started","finishedAt":"$finished","tool":"$version","encryption":"aes-256-cbc",
"secrets":"pgBackRest settings and cipher passphrase from a mode-0400 file",
"backup":{"label":"$label","type":"full","seconds":$backup_seconds},"target":"$target",
"metrics":{"walArchived":${archived:-0},"walArchiveFailures":${archive_failures:-0},"fullBackupStoppedAt":${full_backup_at:-0},"ok":$metrics_ok},
"plaintextMarker":{"inDataDirectory":$in_data,"inRepository":$in_repo},
"tables":$tables,"expected":$expected,"restored":$actual,"rowsWrittenAfterTargetRestored":$after_target,
"runtimeRole":{"reads":$app_reads,"writes":$app_writes,"ddlRefused":$app_ddl_refused},
"restoreSeconds":$restore_seconds,"matches":$matches,"ok":$ok}
JSON
$ok
