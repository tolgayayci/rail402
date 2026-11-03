-- The runtime role's privileges on a Rail402 database, run as a superuser (or the owner role) on that
-- database with psql: after roles.sql, after every migration, and at the end of a restore
-- (restore-dump.sh). It is idempotent.
--
--   psql --set ON_ERROR_STOP=1 --set owner=rail402_owner --set app=rail402_app \
--     --dbname rail402 --file deploy/postgres/grants.sql
--
-- The runtime role reads and writes rows of every table and uses every sequence, now and in tables
-- later migrations create, with these exceptions: the migration bookkeeping and the record of restores
-- (settlement_rewinds, which only the owner writes) are read-only to it, the append-only history
-- (listing versions and the observations behind them) can be read and added to but never changed or
-- removed, and of the ledgers settlement is held from after a restore it may add rows and change only
-- the ledger, never remove one. That lets it end a hold after a restore (setting the ledger to 0), as it
-- could already reopen an off-chain zero by deleting its settlement row; the service moves it only after
-- a corroborated network reset.

GRANT USAGE ON SCHEMA public TO :"app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app";

SET rail402.app = :'app';
DO $$
DECLARE
  app text := current_setting('rail402.app');
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations FROM %I', app);
  END IF;
  IF to_regclass('public.settlement_rewinds') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.settlement_rewinds FROM %I', app);
  END IF;
  IF to_regclass('public.listing_versions') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON public.listing_versions FROM %I', app);
  END IF;
  IF to_regclass('public.listing_observations') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON public.listing_observations FROM %I', app);
  END IF;
  IF to_regclass('public.settlement_rewind_ledgers') IS NOT NULL THEN
    -- Revoking UPDATE on the table revokes it on every column; then only the ledger is granted back.
    EXECUTE format('REVOKE UPDATE, DELETE ON public.settlement_rewind_ledgers FROM %I', app);
    EXECUTE format('GRANT UPDATE (ledger) ON public.settlement_rewind_ledgers TO %I', app);
  END IF;
END
$$;
RESET rail402.app;
