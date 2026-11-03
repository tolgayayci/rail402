-- Registry-scope indexing: instead of reading every ledger, the indexer asks a discovery source (the
-- Lumeus Activity API) which ledgers hold transactions of the registry's facilitator accounts and upto
-- contracts, then reads and verifies only those ledgers. The 64,000-ledger partitions of the full scan
-- and their per-partition exclusion counts give way to discovery routes, candidate ledgers and
-- per-ledger exclusion counts. Settlement rows keep their shape and key.

DROP TABLE partitions;
DROP TABLE excluded;

-- Everything derived from the full scan goes: its rows, failed attempts, anchors, totals and the report
-- (a full-scope document). A registry-scope report counts only rows of the candidate ledgers it lists,
-- so no row of a ledger discovery did not select may survive; the indexer rebuilds all of these from
-- the candidate ledgers, and the web serves no report until the indexer publishes the first new one.
TRUNCATE settlements, failed_attempts, anchors, daily_aggregates, account_totals, reports;

-- One route per registry address and epoch: an account's activity (facilitator accounts), a contract's
-- (upto contracts that emit events), or the approve events naming a contract (upto contracts that emit
-- none), bounded by the address's registry ledger ranges only (never by a bounded run's last ledger).
-- scanned_through is the checkpoint: the last ledger the discovery walk covered, stored in the same
-- transaction as the candidates it found.
CREATE TABLE discovery_routes (
  network text NOT NULL,
  epoch text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('account', 'contract', 'approvals')),
  address text NOT NULL,
  from_ledger bigint NOT NULL CHECK (from_ledger >= 1),
  to_ledger bigint CHECK (to_ledger IS NULL OR to_ledger >= from_ledger),
  scanned_through bigint,
  -- The discovery source's read view of the last stored page; a new generation or decoder walks the
  -- route again from its first ledger.
  generation text,
  decoder_version text,
  snapshot_ledger bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, epoch, kind, address)
);

-- Which route found which ledger. A ledger stays a candidate while any route lists it.
CREATE TABLE candidate_ledgers (
  network text NOT NULL,
  epoch text NOT NULL,
  ledger bigint NOT NULL CHECK (ledger >= 1),
  kind text NOT NULL,
  address text NOT NULL,
  PRIMARY KEY (network, epoch, ledger, kind, address),
  FOREIGN KEY (network, epoch, kind, address)
    REFERENCES discovery_routes (network, epoch, kind, address) ON DELETE CASCADE
);
CREATE INDEX candidate_ledgers_route ON candidate_ledgers (network, epoch, kind, address, ledger);

-- Every candidate ledger and its state: pending until read, verified and classified; indexed with the
-- ledger hash, where its bytes came from and the versions its rows were produced with; failed with the
-- coded reason (an integrity failure stops the indexer and holds the report before this ledger).
-- attributed counts its rows that a registry facilitator settled; a candidate with none is reported.
-- A ledger whose bytes or anchor are not available yet waits until retry_at, so it never holds back
-- newer candidates (the report still stops before it).
CREATE TABLE indexed_ledgers (
  network text NOT NULL,
  epoch text NOT NULL,
  ledger bigint NOT NULL CHECK (ledger >= 1),
  status text NOT NULL CHECK (status IN ('pending', 'indexed', 'failed')),
  hash text CHECK (hash ~ '^[0-9a-f]{64}$'),
  previous_hash text CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  closed_at timestamptz,
  source text CHECK (source IN ('lake', 'rpc')),
  rows bigint NOT NULL DEFAULT 0,
  attributed bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  rules_version text,
  registry_version text,
  classification_sha256 text,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, epoch, ledger)
);
CREATE INDEX indexed_ledgers_pending ON indexed_ledgers (network, epoch, ledger) WHERE status <> 'indexed';

-- Exclusion counts per candidate ledger and reason ("among the transactions in the ledgers read").
CREATE TABLE ledger_exclusions (
  network text NOT NULL,
  epoch text NOT NULL,
  ledger bigint NOT NULL,
  reason text NOT NULL,
  count bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (network, epoch, ledger, reason)
);
