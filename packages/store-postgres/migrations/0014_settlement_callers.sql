-- Who asked for each settlement: `key:<id>` for an access-key holder, `public` otherwise. Each caller's
-- hourly sponsor budget sums the fees of its own settlements.
ALTER TABLE settlements
  ADD COLUMN caller text NOT NULL DEFAULT 'public',
  -- The fee a claim reserves until its envelope is recorded (then max_fee_stroops counts instead), so
  -- concurrent admissions see each other's cost before any of them has signed.
  ADD COLUMN reserved_fee_stroops bigint;

CREATE INDEX settlements_caller_fees ON settlements (network, caller, created_at);
