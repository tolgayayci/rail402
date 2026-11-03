-- Each return of this database to an earlier state: a restore from a dump (restore-dump.sh adds the
-- row in its transaction, creating the table first for a dump taken before it existed) or a
-- point-in-time recovery (the operator adds it). Settlement records written after that state are gone,
-- and an upto zero settled off-chain exists only as such a record, so its authorization could be
-- settled on chain while it is still valid. The facilitator holds on-chain upto settlement for a while
-- after the latest row. Only the schema owner writes rows (grants.sql); the runtime role reads them.
-- restore-dump.sh creates the table with this same statement.
CREATE TABLE IF NOT EXISTS settlement_rewinds (
  id         bigserial   PRIMARY KEY,
  rewound_at timestamptz NOT NULL DEFAULT now(),
  reason     text        NOT NULL
);

-- The ledger of each network the hold after a rewind counts from: the first one a facilitator replica
-- read after the rewind was recorded. Written once per rewind and network, and moved only when the
-- network started over (a reset, whose ledgers count from the start again).
CREATE TABLE settlement_rewind_ledgers (
  rewind_id bigint NOT NULL REFERENCES settlement_rewinds (id),
  network   text   NOT NULL,
  ledger    bigint NOT NULL CHECK (ledger >= 0),
  PRIMARY KEY (rewind_id, network)
);

-- Nothing here tells a live database from one restored from a dump taken before this table existed,
-- whose restore may not be on record: a database that already holds settlements, or was migrated
-- before today, counts as rewound now. A new database is migrated all at once and does not.
DO $$
DECLARE
  existed boolean := EXISTS (SELECT 1 FROM settlements);
BEGIN
  IF NOT existed AND to_regclass('schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(min(applied_at) < now() - interval ''10 minutes'', false) FROM schema_migrations'
      INTO existed;
  END IF;
  IF existed THEN
    INSERT INTO settlement_rewinds (reason) VALUES ('migration');
  END IF;
END
$$;
