-- The channel account's sequence number seen when another transaction took it: the next lease after the
-- quarantine compares it with the account's current one, and a number that moved again means someone
-- still uses the account, so the channel is quarantined once more instead of settling.
ALTER TABLE channels ADD COLUMN quarantine_sequence text;
