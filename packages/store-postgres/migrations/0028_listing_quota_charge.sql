-- From when a listing counts toward its owner's hourly quota of new listings at its origin: its
-- creation, once its origin confirmed a settlement that paid the owner the price there. NULL while
-- none did, and after an ownership transfer. Listings cataloged before this column were never charged.
ALTER TABLE listings ADD COLUMN quota_charged_at timestamptz;
CREATE INDEX listings_owner_quota ON listings (owner, network, quota_charged_at) WHERE quota_charged_at IS NOT NULL;
