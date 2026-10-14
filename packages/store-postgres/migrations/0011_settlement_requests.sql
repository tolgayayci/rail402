-- Request fingerprints: a repeat of a settlement key is answered from its record only when it is the
-- same request (same signed transaction, scheme, network, asset, payTo and settle-time amount).
-- Rows written before this migration have no request_hash and keep comparing payload_hash.
ALTER TABLE settlements
  ADD COLUMN request_hash text,
  -- What the fee sponsor was charged once the transaction was found in a ledger.
  ADD COLUMN fee_charged_stroops bigint,
  -- Who landed the payment: Rail402's own transaction, or another carrying the same authorization.
  ADD COLUMN settled_by text CHECK (settled_by IN ('rail402', 'third_party'));

-- Settlement counts per state over a recent window, for health and metrics.
CREATE INDEX settlements_recent ON settlements (network, created_at);
