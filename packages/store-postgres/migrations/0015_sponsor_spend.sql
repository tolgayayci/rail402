-- What the fee sponsor paid outside settlements (e.g. extending the upto contract's TTL). It counts
-- toward each network's hourly fee budget like a settlement's fee, and toward the keeper's daily cap.
CREATE TABLE sponsor_spend (
  id          bigserial   PRIMARY KEY,
  network     text        NOT NULL,
  kind        text        NOT NULL,
  fee_stroops bigint      NOT NULL CHECK (fee_stroops >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sponsor_spend_recent ON sponsor_spend (network, created_at);

-- Included settlements that failed, per payer, for the failed-settlement cooldown.
CREATE INDEX settlements_payer_failures ON settlements (network, payer, updated_at)
  WHERE state = 'failed' AND fee_charged_stroops IS NOT NULL;
