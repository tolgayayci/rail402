-- The account each observed settlement paid, so usage counts only the settlements that paid a listing's
-- current owner: never another payTo's settlement for the same resource, nor a previous owner's.
ALTER TABLE listing_observations ADD COLUMN pay_to text;

-- Earlier rows did not record it: take the owner of the listing's version current when the settlement
-- was observed. That is the account a settlement paid, except for one that another payTo made while
-- claiming the listing, which an earlier row cannot be told apart from: such a backfilled row can link a
-- settlement to the current owner although it paid someone else. Readers that hold the settlement
-- itself check the link against its on-chain payTo (the Explorer shows a link only when they match).
UPDATE listing_observations o
SET pay_to = (
  SELECT v.owner
  FROM listing_versions v
  WHERE v.listing_id = o.listing_id AND v.created_at <= o.observed_at
  ORDER BY v.version DESC
  LIMIT 1
);

-- A listing's usage and its latest settlements.
CREATE INDEX listing_observations_usage ON listing_observations (listing_id, pay_to, observed_at DESC);
