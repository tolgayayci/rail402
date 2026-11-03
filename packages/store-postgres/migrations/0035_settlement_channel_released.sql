-- Whether a submitted settlement gave its channel back before it finished: its recorded bytes can
-- never apply, because another transaction took the channel's sequence number or they were included
-- and failed (which used it), while its outcome still waits for the payer's authorization. The channel
-- pool may lease such a channel again, and finishing the settlement releases nothing.
ALTER TABLE settlements ADD COLUMN channel_released boolean NOT NULL DEFAULT false;
