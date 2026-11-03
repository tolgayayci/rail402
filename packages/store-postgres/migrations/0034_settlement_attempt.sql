-- The settle attempt id the request that started a settlement carried, echoed in every repeat's marker
-- so a resource server can tell the answer to its own lost or pending attempt from another's. Records
-- written before this migration, and requests without an id, keep it NULL.
ALTER TABLE settlements ADD COLUMN settle_attempt text;
