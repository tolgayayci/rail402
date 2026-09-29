-- Origin checks are claimed by one worker at a time (any replica), and each request has an id: a
-- check re-requested while it is being fetched is not lost when the earlier fetch completes.
ALTER TABLE origin_checks
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN request_id    uuid NOT NULL DEFAULT gen_random_uuid();
