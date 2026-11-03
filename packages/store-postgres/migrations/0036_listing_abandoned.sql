-- Listings never published and withdrawn, oldest first: the catalog deletes those withdrawn for a week.
CREATE INDEX listings_abandoned ON listings (last_updated) WHERE state = 'quarantined' AND listed_at IS NULL;
