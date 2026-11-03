-- The paths settlements that paid a listing's owner asked its origin check to try, each with its
-- payment, proposed call and how a run of the open check found it, in the order they came. A listing
-- not yet listed is listed from one its origin confirms; a later settlement adds its own and never
-- removes a larger payment.
ALTER TABLE origin_checks ADD COLUMN candidates jsonb NOT NULL DEFAULT '[]'::jsonb;
-- When a check's scheduled retry is, while a settlement made it due before then: such an early run
-- that fails for now waits for that retry and spends none.
ALTER TABLE origin_checks ADD COLUMN retry_at timestamptz;

-- A check requested before keeps the path, payment and call of the settlement that requested it, a
-- claim's check included when the owner's own settlement joined it.
UPDATE origin_checks
SET candidates = jsonb_build_array(
  jsonb_build_object('url', url)
    || CASE WHEN settled_option IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('settled', settled_option) END
    || CASE WHEN probe IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('probe', probe) END
)
WHERE settled_option IS NOT NULL OR reason <> 'owner_conflict';
