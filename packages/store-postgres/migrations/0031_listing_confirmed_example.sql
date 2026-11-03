-- The path of a route-template listing's example (info.input.pathParams) its origin confirmed, spelled
-- as it was asked: the path of the check that listed it. Examples kept from before were whatever the
-- payer of the first settlement echoed: they have none, still weigh claims, and never withdraw or
-- rewrite the listing until their own path's answer lists it.
ALTER TABLE listings ADD COLUMN confirmed_example text;
