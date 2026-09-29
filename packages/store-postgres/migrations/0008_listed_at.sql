-- When a listing was first published: the stable order of GET /discovery/resources, and what an
-- `asOf` page pin compares against. Pending listings have none yet.
ALTER TABLE listings ADD COLUMN listed_at timestamptz;
UPDATE listings SET listed_at = first_cataloged_at WHERE state <> 'pending';
CREATE INDEX listings_listed_order ON listings (listed_at, sequence) WHERE state = 'published';
