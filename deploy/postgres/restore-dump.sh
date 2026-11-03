#!/usr/bin/env bash
# Replaces the public schema of a Rail402 database with a pg_dump custom-format dump (backup.sh's), in
# one transaction: anything but a complete restore rolls back and leaves the database as it was.
#
#   deploy/postgres/restore-dump.sh [--owner ROLE --app ROLE] <dump file>
#
#   --owner, --app  the roles of a split setup (roles.sql). The dump's objects are then created as the
#                   owner role, so the owner keeps owning the schema and every table, the owner's default
#                   privileges are set again on the new schema, and grants.sql gives the runtime role
#                   its privileges. Without them every object belongs to the connecting superuser, as
#                   in a one-role setup.
#   PG_EXEC         the command that runs pg_restore and psql next to the database, word-split, e.g.
#                   "docker compose exec -T postgres" (default: run them here)
#   PGUSER          a superuser (default postgres)        PGDATABASE  default rail402
#
# Tables a newer migration added are dropped with the schema, so a dump from before an upgrade leaves a
# database the newer release migrates again.
#
# The same transaction records the restore in settlement_rewinds, creating the table as its migration
# does when the dump is older than it: settlements recorded after the dump are gone, and an upto zero
# settled off-chain among them spent no nonce, so the facilitator holds on-chain upto settlement until
# every authorization from before the restore has expired.
set -euo pipefail

owner="" app="" dump=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) owner="$2"; shift 2 ;;
    --app) app="$2"; shift 2 ;;
    -*) printf 'error: unknown option %s\n' "$1" >&2; exit 2 ;;
    *) dump="$1"; shift ;;
  esac
done
[[ -n "$dump" && -r "$dump" ]] || { printf 'usage: restore-dump.sh [--owner ROLE --app ROLE] <dump file>\n' >&2; exit 2; }
[[ -z "$owner" && -z "$app" ]] || [[ "$owner" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$app" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
  { printf 'error: give both --owner and --app, as role names\n' >&2; exit 2; }
grants="$(dirname "$(readlink -f "$0")")/grants.sql"
[[ -z "$owner" || -f "$grants" ]] || { printf 'error: grants.sql is missing next to this script\n' >&2; exit 1; }
read -r -a pg_exec <<<"${PG_EXEC:-}"
run() { "${pg_exec[@]}" "$@"; }
run pg_restore --list <"$dump" >/dev/null || { printf 'error: %s is not a pg_dump custom-format dump\n' "$dump" >&2; exit 1; }

# pg_restore renders the dump as SQL; psql applies it in one transaction and stops at the first error.
# Only a complete rendering ends with COMMIT.
{
  printf 'SET client_min_messages = warning;\nBEGIN;\nDROP SCHEMA public CASCADE;\n'
  if [[ -n "$owner" ]]; then
    printf '\\set owner %s\n\\set app %s\n' "$owner" "$app"
    printf 'CREATE SCHEMA public AUTHORIZATION :"owner";\nREVOKE ALL ON SCHEMA public FROM PUBLIC;\n'
    printf 'SET ROLE :"owner";\n'
  else
    printf 'CREATE SCHEMA public;\n'
  fi
  if run pg_restore --no-owner --no-privileges --file - <"$dump"; then
    # pg_restore's script empties search_path, hence the schema-qualified names.
    cat <<'SQL'
CREATE TABLE IF NOT EXISTS public.settlement_rewinds (
  id         bigserial   PRIMARY KEY,
  rewound_at timestamptz NOT NULL DEFAULT now(),
  reason     text        NOT NULL
);
INSERT INTO public.settlement_rewinds (reason) VALUES ('restore');
SQL
    if [[ -n "$owner" ]]; then
      printf 'RESET ROLE;\n'
      cat "$grants"
    fi
    printf 'COMMIT;\n'
  else
    printf 'ROLLBACK;\n'
    exit 1
  fi
} | run psql --username "${PGUSER:-postgres}" --dbname "${PGDATABASE:-rail402}" --quiet --no-psqlrc --set ON_ERROR_STOP=1 >/dev/null
