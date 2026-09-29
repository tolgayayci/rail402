-- Stellar facts about a published listing, refreshed in the background and not part of its versioned
-- content: each payment option's token symbol, name and decimals, whether payTo can receive it, and
-- whether the resource's domain claims the owner in its SEP-1 stellar.toml.
ALTER TABLE listings
  ADD COLUMN facts jsonb,
  ADD COLUMN facts_checked_at timestamptz;
CREATE INDEX listings_facts_due ON listings (facts_checked_at NULLS FIRST) WHERE state = 'published';

ALTER TABLE listings DROP CONSTRAINT listings_trust_check;
ALTER TABLE listings
  ADD CONSTRAINT listings_trust_check CHECK (trust IN ('settled', 'origin_verified', 'domain_verified'));

ALTER TABLE listing_versions DROP CONSTRAINT listing_versions_cause_check;
ALTER TABLE listing_versions
  ADD CONSTRAINT listing_versions_cause_check CHECK (
    cause IN ('settlement', 'origin_verification', 'ownership_transfer', 'quarantine', 'domain_verification')
  );
