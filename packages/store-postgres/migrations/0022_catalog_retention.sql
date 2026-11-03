-- An origin check keeps every payTo that claims its listing, so one claimant never replaces another's
-- claim before a check ran with it.
ALTER TABLE origin_checks ADD COLUMN proposed_owners text[] NOT NULL DEFAULT '{}';
UPDATE origin_checks SET proposed_owners = ARRAY[proposed_owner] WHERE proposed_owner IS NOT NULL;
ALTER TABLE origin_checks DROP COLUMN proposed_owner;
-- Retention, facts refreshes and the published-listing cap all read one network's published listings.
CREATE INDEX listings_network_settled ON listings (network, last_settled_at) WHERE state = 'published';
CREATE INDEX listings_network_facts ON listings (network, facts_checked_at) WHERE state = 'published';
