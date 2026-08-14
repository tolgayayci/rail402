#!/bin/sh
# Drop privileges after making the catalog volume writable (F9).
#
# The process holds settlement keys, so it must not run as root. But managed hosts (Railway, Fly)
# mount the /data volume ROOT-OWNED, and an unprivileged user cannot open a database file under it
# (SQLITE_CANTOPEN) — which is exactly why the image used to stay root. So: start as root ONLY to
# chown the volume, then exec the app as the unprivileged `node` user. gosu re-execs (no extra
# process, correct signal forwarding as PID 1).
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  # Best-effort: on a host with no writable /data (no volume) this is a no-op and the app runs with
  # an in-memory catalog just the same.
  chown -R node:node /data 2>/dev/null || true
  exec gosu node "$@"
fi

# Already unprivileged (e.g. a host that runs the container as a fixed non-root uid): just run.
exec "$@"
