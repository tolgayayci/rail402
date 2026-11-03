-- The Explorer's own database: settlements indexed from ledgers under the published rules, the
-- registry they were attributed with, and progress. Nothing here is secret and nothing references the
-- facilitator's database. Every row is rebuildable from public ledgers.

CREATE TABLE settlements (
  network text NOT NULL,
  epoch text NOT NULL,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  inner_hash text CHECK (inner_hash ~ '^[0-9a-f]{64}$'),
  ledger bigint NOT NULL,
  tx_index integer NOT NULL,
  closed_at timestamptz NOT NULL,
  scheme text NOT NULL CHECK (scheme IN ('exact', 'upto')),
  rule_id text NOT NULL,
  rules_version text NOT NULL,
  registry_version text NOT NULL,
  asset_contract text NOT NULL,
  asset_code text,
  asset_issuer text,
  asset_verified boolean NOT NULL,
  payer text NOT NULL,
  payer_kind text NOT NULL CHECK (payer_kind IN ('G', 'C')),
  pay_to text NOT NULL,
  pay_to_muxed_id text,
  amount numeric(39, 0) NOT NULL CHECK (amount >= 0),
  max_amount numeric(39, 0),
  upto_contract text,
  upto_authority text,
  fee_bump boolean NOT NULL,
  fee_payer text NOT NULL,
  inner_source text NOT NULL,
  op_source text NOT NULL,
  fee_charged bigint NOT NULL,
  sponsored boolean NOT NULL,
  tier text NOT NULL CHECK (tier IN ('rail402', 'rail402-beta', 'facilitator', 'shaped')),
  facilitator_id text,
  evidence_url text,
  -- The facilitator also relays transfers that are not x402 payments (registry sharedRelayer).
  shared_relayer boolean NOT NULL,
  checks text[] NOT NULL,
  PRIMARY KEY (network, epoch, tx_hash),
  UNIQUE (network, epoch, inner_hash)
);

-- Keyset pages per address and facilitator, newest first, and ledger-ordered scans for rebuilds.
CREATE INDEX settlements_position ON settlements (network, epoch, ledger, tx_index);
CREATE INDEX settlements_payer ON settlements (network, payer, ledger DESC, tx_index DESC);
CREATE INDEX settlements_pay_to ON settlements (network, pay_to, ledger DESC, tx_index DESC);
CREATE INDEX settlements_facilitator ON settlements (network, facilitator_id, ledger DESC, tx_index DESC);
CREATE INDEX settlements_inner_hash ON settlements (inner_hash) WHERE inner_hash IS NOT NULL;
CREATE INDEX settlements_closed_at ON settlements (network, epoch, closed_at);

CREATE TABLE failed_attempts (
  network text NOT NULL,
  epoch text NOT NULL,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  ledger bigint NOT NULL,
  tx_index integer NOT NULL,
  scheme text NOT NULL CHECK (scheme IN ('exact', 'upto')),
  result_code text NOT NULL,
  fee_payer text NOT NULL,
  fee_charged bigint NOT NULL,
  PRIMARY KEY (network, epoch, tx_hash)
);
CREATE INDEX failed_attempts_position ON failed_attempts (network, epoch, ledger, tx_index);

-- Exclusion counts per reason and partition, so totals can be audited.
CREATE TABLE excluded (
  network text NOT NULL,
  epoch text NOT NULL,
  partition_start bigint NOT NULL,
  reason text NOT NULL,
  count bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (network, epoch, partition_start, reason)
);

-- Progress per 64,000-ledger partition of the data lake. next_ledger is the resume point; the
-- first and last hashes link partitions into one chain.
CREATE TABLE partitions (
  network text NOT NULL,
  epoch text NOT NULL,
  start_ledger bigint NOT NULL,
  end_ledger bigint NOT NULL CHECK (end_ledger >= start_ledger),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  next_ledger bigint NOT NULL,
  first_ledger bigint,
  first_previous_hash text,
  last_ledger bigint,
  last_ledger_hash text,
  rows bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0,
  rules_version text NOT NULL,
  registry_version text NOT NULL,
  -- classificationFingerprint() of the registry the rows were classified with: when it changes, the
  -- partition is indexed again; a registry change that keeps it only re-attributes the rows in place.
  classification_sha256 text NOT NULL,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (network, epoch, start_ledger)
);

-- The registry the rows were attributed with, loaded from packages/x402-index/registry.
CREATE TABLE facilitators (
  network text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('rail402', 'rail402-beta', 'facilitator')),
  shared_relayer boolean NOT NULL,
  registry_version text NOT NULL,
  PRIMARY KEY (network, id)
);

CREATE TABLE facilitator_accounts (
  network text NOT NULL,
  facilitator_id text NOT NULL,
  address text NOT NULL,
  role text NOT NULL,
  epoch text NOT NULL,
  valid_from bigint NOT NULL,
  valid_to bigint,
  evidence_url text NOT NULL,
  evidence_sha256 text NOT NULL,
  PRIMARY KEY (network, address, epoch, valid_from),
  FOREIGN KEY (network, facilitator_id) REFERENCES facilitators (network, id) ON DELETE CASCADE
);

CREATE TABLE upto_contracts (
  network text NOT NULL,
  contract text NOT NULL,
  wasm_sha256 text NOT NULL,
  epoch text NOT NULL,
  valid_from bigint NOT NULL,
  valid_to bigint,
  rule text NOT NULL,
  facilitator_id text,
  PRIMARY KEY (network, contract, epoch, valid_from)
);

-- Totals per account, side and asset, for account pages: recomputed for every account a commit or a
-- reset touches, so a page reads one indexed row per asset instead of aggregating the account's history.
CREATE TABLE account_totals (
  network text NOT NULL,
  epoch text NOT NULL,
  address text NOT NULL,
  role text NOT NULL CHECK (role IN ('payer', 'payTo')),
  asset_contract text NOT NULL,
  asset_code text,
  asset_issuer text,
  asset_verified boolean NOT NULL,
  payments bigint NOT NULL,
  volume numeric(48, 0) NOT NULL,
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (network, epoch, address, role, asset_contract)
);

-- The latest report per network and epoch, computed by the indexer and read by every web process, so
-- replicas never rescan the settlements themselves.
CREATE TABLE reports (
  network text NOT NULL,
  epoch text NOT NULL,
  generated_at timestamptz NOT NULL,
  document text NOT NULL,
  manifest text NOT NULL,
  aggregates text NOT NULL,
  PRIMARY KEY (network, epoch)
);

-- Daily totals for the report; recomputed for every day a commit touches.
CREATE TABLE daily_aggregates (
  network text NOT NULL,
  epoch text NOT NULL,
  day date NOT NULL,
  tier text NOT NULL,
  facilitator_id text NOT NULL,
  scheme text NOT NULL,
  asset_contract text NOT NULL,
  self_payment boolean NOT NULL,
  payments bigint NOT NULL,
  volume numeric(48, 0) NOT NULL,
  PRIMARY KEY (network, epoch, day, tier, facilitator_id, scheme, asset_contract, self_payment)
);
