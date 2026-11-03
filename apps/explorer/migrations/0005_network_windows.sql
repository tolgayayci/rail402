-- The network-wide block of the Ecosystem Report: the latest full-scope rebuild of a recent window of
-- ledgers per network and epoch, written by the network window job (off unless configured) and read by
-- every web process. The document and the manifest are stored exactly as published.
CREATE TABLE network_windows (
  network text NOT NULL,
  epoch text NOT NULL,
  generated_at timestamptz NOT NULL,
  from_ledger bigint NOT NULL,
  to_ledger bigint NOT NULL,
  document text NOT NULL,
  manifest text NOT NULL,
  PRIMARY KEY (network, epoch),
  CHECK (from_ledger <= to_ledger)
);
