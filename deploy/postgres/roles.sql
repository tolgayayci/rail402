-- Database roles for a Rail402 deployment: an owner role that runs the migrations and owns the schema,
-- and a runtime role that the service uses for requests. Neither is a superuser or can create roles or
-- databases; the runtime role can read and write rows but cannot create, alter or drop anything.
--
-- Run once as a superuser with psql, giving the names and passwords as variables, followed by
-- grants.sql (the runtime role's privileges, which is run again after every migration and restore):
--
--   psql --set ON_ERROR_STOP=1 \
--     --set owner=rail402_owner --set owner_password="$OWNER_PASSWORD" \
--     --set app=rail402_app --set app_password="$APP_PASSWORD" \
--     --set database=rail402 --set app_connection_limit=66 \
--     --file deploy/postgres/roles.sql --file deploy/postgres/grants.sql
--
-- app_connection_limit must hold every pool of every replica at once, plus room for check-config and the
-- CLI: 28 per replica serving testnet and pubnet with the Bazaar (see "Database roles" in the operations
-- guide), so replicas × 28 plus 10: 66 for two. The service logs how many replicas the limit holds, and with pubnet refuses to
-- start below one (config_database_connections_low).
--
-- Then point the migration command at the owner role (DATABASE_MIGRATION_URL_FILE) and the service at
-- the runtime role (DATABASE_URL_FILE). Running it on an existing database also hands every table and
-- sequence already in the public schema (for example, created by an earlier superuser setup) to the owner.

CREATE ROLE :"owner" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'owner_password';
CREATE ROLE :"app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT :app_connection_limit PASSWORD :'app_password';

REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"database" TO :"owner";
GRANT CONNECT ON DATABASE :"database" TO :"app";
-- The maintenance databases are for superusers only; the service's roles never connect to them.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;

\connect :"database"

REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"owner";
GRANT USAGE ON SCHEMA public TO :"app";

-- Tables and sequences that already exist move to the owner, so later migrations can alter them.
SET rail402.owner = :'owner';
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      -- A sequence that belongs to a column moves with its table.
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
    ORDER BY c.relkind = 'S'
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO %I',
      CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      item.relname,
      current_setting('rail402.owner')
    );
  END LOOP;
END
$$;
