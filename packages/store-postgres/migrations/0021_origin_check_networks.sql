-- Origin checks are claimed per network, so a backlog of one network's checks never holds up
-- another's. Each check carries its listing's network.
ALTER TABLE origin_checks ADD COLUMN network text;
UPDATE origin_checks c SET network = l.network FROM listings l WHERE l.id = c.listing_id;
ALTER TABLE origin_checks ALTER COLUMN network SET NOT NULL;
CREATE INDEX origin_checks_network_due ON origin_checks (network, due_at);
