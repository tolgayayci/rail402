#!/usr/bin/env bash
# Writes Prometheus metrics for WAL archiving and pgBackRest backups to a file for node_exporter's
# textfile collector (deploy/monitoring/compose.example.yaml). Run it every minute, from a timer:
#
#   deploy/postgres/backup-metrics.sh <directory>      writes <directory>/rail402_backup.prom
#
#   PG_EXEC     the command that runs psql and pgbackrest next to the database, word-split, for example
#               "docker compose exec -T postgres" (default: run them here)
#   PGUSER      the role psql connects as (default postgres); it needs pg_monitor or superuser, because
#               it reads pg_stat_archiver and the archive status directory
#   PGDATABASE  default postgres
#
# The file is written to a temporary name and renamed, so the collector never reads half of it. The
# metrics (alerts.yml, group rail402-host, reads them):
#   rail402_wal_archive_enabled                       1 when archive_mode is on
#   rail402_wal_archived_total, rail402_wal_archive_failures_total
#   rail402_wal_last_archived_timestamp_seconds, rail402_wal_last_failed_timestamp_seconds
#   rail402_wal_archive_pending_segments              segments waiting for the archive (.ready files)
#   rail402_wal_archive_oldest_pending_seconds        how long the oldest of them has waited
#   rail402_backup_last_completed_timestamp_seconds{type}  newest completed pgBackRest backup per type
#   rail402_backup_metrics_collected_timestamp_seconds     when this file was written
# A failed read leaves the previous file in place, so its collected timestamp ages and
# Rail402BackupMetricsStale fires. When pgBackRest lists no completed backup, or cannot read the
# repository, the backup series is left out: Rail402BackupStale fires on its absence once archiving
# has been on for 6 hours.
set -euo pipefail

directory="${1:?usage: backup-metrics.sh <textfile directory>}"
[[ -d "$directory" ]] || {
  printf 'error: %s is not a directory\n' "$directory" >&2
  exit 1
}
read -r -a pg_exec <<<"${PG_EXEC:-}"
run() { "${pg_exec[@]}" "$@"; }

wal="$(run psql -X -A -t -q -v ON_ERROR_STOP=1 -U "${PGUSER:-postgres}" -d "${PGDATABASE:-postgres}" -F ' ' -c "
  SELECT (current_setting('archive_mode') <> 'off')::int,
         archived_count, failed_count,
         coalesce(extract(epoch FROM last_archived_time), 0)::bigint,
         coalesce(extract(epoch FROM last_failed_time), 0)::bigint,
         (SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'),
         coalesce((SELECT extract(epoch FROM now() - min(modification))::bigint
                   FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'), 0)
  FROM pg_stat_archiver")"
read -r enabled archived failed last_archived last_failed pending oldest <<<"$wal"
for value in "$enabled" "$archived" "$failed" "$last_archived" "$last_failed" "$pending" "$oldest"; do
  [[ "$value" =~ ^[0-9]+$ ]] || {
    printf 'error: unexpected answer from pg_stat_archiver\n' >&2
    exit 1
  }
done

# pgBackRest's JSON lists each backup with "timestamp":{"start":…,"stop":…},"type":"full|diff|incr";
# the newest stop time per type is the last completed backup of that type.
backups=""
if [[ "$enabled" == 1 ]] && info="$(run pgbackrest info --output=json 2>/dev/null)"; then
  backups="$(grep -oE '"timestamp":\{"start":[0-9]+,"stop":[0-9]+\},"type":"(full|diff|incr)"' <<<"$info" |
    sed -E 's/.*"stop":([0-9]+)\},"type":"([a-z]+)"/\2 \1/' |
    sort -k1,1 -k2,2n | awk '{ last[$1] = $2 } END { for (t in last) print t, last[t] }' | sort)"
fi

target="$directory/rail402_backup.prom"
tmp="$(mktemp "$directory/.rail402_backup.prom.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  printf '# HELP rail402_wal_archive_enabled 1 when Postgres archives WAL (archive_mode is not off).\n'
  printf '# TYPE rail402_wal_archive_enabled gauge\nrail402_wal_archive_enabled %s\n' "$enabled"
  printf '# HELP rail402_wal_archived_total WAL segments archived since the statistics were reset.\n'
  printf '# TYPE rail402_wal_archived_total counter\nrail402_wal_archived_total %s\n' "$archived"
  printf '# HELP rail402_wal_archive_failures_total Failed attempts to archive a WAL segment.\n'
  printf '# TYPE rail402_wal_archive_failures_total counter\nrail402_wal_archive_failures_total %s\n' "$failed"
  printf '# HELP rail402_wal_last_archived_timestamp_seconds When the last WAL segment was archived (0: never).\n'
  printf '# TYPE rail402_wal_last_archived_timestamp_seconds gauge\nrail402_wal_last_archived_timestamp_seconds %s\n' "$last_archived"
  printf '# HELP rail402_wal_last_failed_timestamp_seconds When archiving last failed (0: never).\n'
  printf '# TYPE rail402_wal_last_failed_timestamp_seconds gauge\nrail402_wal_last_failed_timestamp_seconds %s\n' "$last_failed"
  printf '# HELP rail402_wal_archive_pending_segments WAL segments waiting to be archived.\n'
  printf '# TYPE rail402_wal_archive_pending_segments gauge\nrail402_wal_archive_pending_segments %s\n' "$pending"
  printf '# HELP rail402_wal_archive_oldest_pending_seconds How long the oldest waiting WAL segment has waited.\n'
  printf '# TYPE rail402_wal_archive_oldest_pending_seconds gauge\nrail402_wal_archive_oldest_pending_seconds %s\n' "$oldest"
  if [[ -n "$backups" ]]; then
    printf '# HELP rail402_backup_last_completed_timestamp_seconds When the newest completed pgBackRest backup of each type stopped.\n'
    printf '# TYPE rail402_backup_last_completed_timestamp_seconds gauge\n'
    while read -r type stop; do
      printf 'rail402_backup_last_completed_timestamp_seconds{type="%s"} %s\n' "$type" "$stop"
    done <<<"$backups"
  fi
  printf '# HELP rail402_backup_metrics_collected_timestamp_seconds When this file was written.\n'
  printf '# TYPE rail402_backup_metrics_collected_timestamp_seconds gauge\nrail402_backup_metrics_collected_timestamp_seconds %s\n' "$(date +%s)"
} >"$tmp"
chmod 644 "$tmp"
mv "$tmp" "$target"
trap - EXIT
