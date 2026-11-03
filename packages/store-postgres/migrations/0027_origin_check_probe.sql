-- The unpaid tool call an MCP origin check may try when the tool does not answer the call its listing
-- describes with a 402: the example arguments and transport of the owner's settlement that requested it.
ALTER TABLE origin_checks ADD COLUMN probe jsonb;

-- Every quarantine records why. Versions written before reasons were recorded keep their empty reason.
ALTER TABLE listing_versions
  ADD CONSTRAINT listing_versions_quarantine_reason CHECK (cause <> 'quarantine' OR reason IS NOT NULL) NOT VALID;
