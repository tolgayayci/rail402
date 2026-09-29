-- A new HTTP listing waits in 'pending' until its resource's own 402 response confirms it.
ALTER TABLE listings DROP CONSTRAINT listings_state_check;
ALTER TABLE listings
  ADD CONSTRAINT listings_state_check CHECK (state IN ('pending', 'published', 'quarantined'));

-- A settlement pays for one resource, so it catalogs at most one listing: replaying a settled
-- payment with another resource must not mint a second one.
CREATE UNIQUE INDEX listing_observations_transaction ON listing_observations (transaction);
