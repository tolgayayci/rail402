-- Catalog budgets are kept per network: the hourly new-listing counts filter on the listing's network.
CREATE INDEX listings_network_created ON listings (network, first_cataloged_at);
