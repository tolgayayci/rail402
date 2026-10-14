-- Why an origin check quarantined a listing, on its 'quarantine' version.
ALTER TABLE listing_versions ADD COLUMN reason text;

-- The payment option of the settlement that requested an origin check. An MCP tool whose content its
-- origin never confirmed is published only if the tool offers this option.
ALTER TABLE origin_checks ADD COLUMN settled_option jsonb;

-- MCP tools at an http(s) endpoint are origin-checked like HTTP resources. Tools published before
-- that, whose content no origin check ever confirmed, are checked now: the check replaces their
-- content with the tool's own, or quarantines them.
INSERT INTO origin_checks (listing_id, reason, url)
  SELECT l.id, 'changed', l.resource
  FROM listings l
  WHERE l.kind = 'mcp'
    AND l.resource ~ '^https?://'
    AND l.state = 'published'
    AND NOT EXISTS (
      SELECT 1 FROM listing_versions v
      WHERE v.listing_id = l.id AND v.cause IN ('origin_verification', 'ownership_transfer')
    )
ON CONFLICT (listing_id) DO NOTHING;
