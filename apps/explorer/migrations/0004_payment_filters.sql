-- The payments list filters by scheme and by asset, newest first: one index per filter, in the list's
-- order, so a rare scheme or asset never makes a page scan the whole epoch.
CREATE INDEX settlements_scheme ON settlements (network, epoch, scheme, ledger DESC, tx_index DESC);
CREATE INDEX settlements_asset ON settlements (network, epoch, asset_contract, ledger DESC, tx_index DESC);
