-- The most each recorded settlement can cost the sponsor (its fee-bump fee), for the hourly budget.
ALTER TABLE settlements ADD COLUMN max_fee_stroops bigint;
CREATE INDEX settlements_committed_fees ON settlements (network, created_at) WHERE max_fee_stroops IS NOT NULL;
