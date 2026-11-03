-- Whether the network accepted a send of a settlement's recorded bytes, and the sends whose answer is
-- not known. A record written before this migration keeps broadcast_accepted NULL and counts as
-- accepted: its bytes may have been seen by anyone.
ALTER TABLE settlements ADD COLUMN broadcast_accepted boolean;
ALTER TABLE settlements ADD COLUMN sends_in_flight text[] NOT NULL DEFAULT '{}';
