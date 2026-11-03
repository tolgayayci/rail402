-- Ledger hashes the indexer checked against an independent source (a Horizon with full history) before
-- it committed the rows that end at those ledgers: the start of every chain it read, and the end of
-- every batch. A published manifest lists the anchors inside its range.
CREATE TABLE anchors (
  network text NOT NULL,
  epoch text NOT NULL,
  ledger bigint NOT NULL CHECK (ledger >= 1),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  source text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, epoch, ledger)
);
