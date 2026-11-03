-- The hourly quota of new listings counts listings by when they were first published (listed_at),
-- whatever their state now, so a listing staged pending for hours counts in the hour it is published.
CREATE INDEX listings_network_listed ON listings (network, listed_at) WHERE listed_at IS NOT NULL;
