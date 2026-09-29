-- Settlement ledger: one row per payer authorization (network, payer, nonce).
-- The signed envelope is written before broadcast, so a submitted settlement can always be found
-- again and is never replaced by a different transaction.
CREATE TABLE settlements (
  id                      uuid PRIMARY KEY,
  network                 text        NOT NULL,
  payer                   text        NOT NULL,
  nonce                   text        NOT NULL,
  payload_hash            text        NOT NULL,
  state                   text        NOT NULL
                          CHECK (state IN ('claimed', 'submitted', 'succeeded', 'failed', 'expired')),
  owner                   text        NOT NULL,
  claim_expires_at        timestamptz NOT NULL,
  channel                 text,
  transaction_hash        text,
  inner_transaction_hash  text,
  envelope_xdr            text,
  valid_until             bigint,
  response                jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, payer, nonce),
  -- A submitted or terminal-after-submission row always carries its complete envelope.
  CHECK (state = 'claimed' OR (channel IS NOT NULL AND transaction_hash IS NOT NULL
                               AND envelope_xdr IS NOT NULL AND valid_until IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'expired')) = (response IS NOT NULL))
);

CREATE UNIQUE INDEX settlements_transaction_hash ON settlements (transaction_hash)
  WHERE transaction_hash IS NOT NULL;
CREATE INDEX settlements_unfinished ON settlements (network, channel) WHERE state = 'submitted';

-- Channel accounts and their exclusive leases. A channel with a submitted settlement stays leased
-- until that settlement is final, whatever its lease expiry says.
CREATE TABLE channels (
  network           text        NOT NULL,
  address           text        NOT NULL,
  leased_at         timestamptz,
  lease_expires_at  timestamptz,
  released_at       timestamptz,
  PRIMARY KEY (network, address),
  CHECK ((leased_at IS NULL) = (lease_expires_at IS NULL))
);
