-- A channel whose sequence number another transaction took is kept out of rotation until
-- quarantined_until; conflict_streak counts its quarantines since its last plain release and doubles
-- the next cooldown.
ALTER TABLE channels ADD COLUMN quarantined_until timestamptz;
ALTER TABLE channels ADD COLUMN conflict_streak integer NOT NULL DEFAULT 0 CHECK (conflict_streak >= 0);
