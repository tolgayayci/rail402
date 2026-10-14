-- Settlements of more than one x402 scheme. `amount` is the settle-time amount in base units: for
-- `upto` it is chosen at settlement, anywhere from zero to the authorized cap.
ALTER TABLE settlements
  ADD COLUMN scheme text NOT NULL DEFAULT 'exact',
  ADD COLUMN amount text CHECK (amount ~ '^(0|[1-9][0-9]*)$');

-- A submitted or finished settlement still carries its complete envelope, with one exception: an
-- `upto` settlement of zero that the operator settles off-chain succeeds without any transaction.
ALTER TABLE settlements DROP CONSTRAINT settlements_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_envelope CHECK (
  state = 'claimed'
  OR (channel IS NOT NULL AND transaction_hash IS NOT NULL
      AND envelope_xdr IS NOT NULL AND valid_until IS NOT NULL)
  OR (scheme = 'upto' AND amount = '0' AND state = 'succeeded'
      AND channel IS NULL AND transaction_hash IS NULL AND envelope_xdr IS NULL)
);
