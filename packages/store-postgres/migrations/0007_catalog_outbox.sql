-- Settled payments waiting to be cataloged. A row is written before cataloging starts and deleted
-- once it reached an outcome, so a crash mid-way leaves it for a background worker to finish.
CREATE TABLE catalog_outbox (
  transaction    text        PRIMARY KEY,
  payment        jsonb       NOT NULL,
  attempts       integer     NOT NULL DEFAULT 0,
  due_at         timestamptz NOT NULL,
  claimed_until  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_outbox_due ON catalog_outbox (due_at);
