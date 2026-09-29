-- The catalog revision as a row that each catalog transaction updates, instead of a sequence. A
-- sequence advances before its transaction commits, so a search index could read revision N without
-- N's change and never rebuild for it; a row is read in the same snapshot as the listings.
CREATE TABLE catalog_state (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision   bigint  NOT NULL CHECK (revision >= 0)
);
INSERT INTO catalog_state (revision)
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM catalog_revision;
-- catalog_revision stays until the next release: a replica of the previous version still bumps it
-- while a rolling deploy overlaps the two.
