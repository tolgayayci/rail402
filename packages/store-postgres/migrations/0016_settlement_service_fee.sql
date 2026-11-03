-- The service fee in US dollars a settlement accrues, as priced when it was claimed. A later price
-- change never reprices settlements already recorded.
ALTER TABLE settlements
  ADD COLUMN service_fee_usd numeric(20, 7) NOT NULL DEFAULT 0;
