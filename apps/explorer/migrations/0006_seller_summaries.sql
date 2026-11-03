-- Each payTo address's payment counts and distinct payers per network and epoch, kept by the indexer
-- with the account totals, so an account page never aggregates a seller's settlements per view.
CREATE TABLE seller_summaries (
  network text NOT NULL,
  epoch text NOT NULL,
  pay_to text NOT NULL,
  exact bigint NOT NULL,
  upto bigint NOT NULL,
  payers bigint NOT NULL,
  PRIMARY KEY (network, epoch, pay_to)
);

INSERT INTO seller_summaries (network, epoch, pay_to, exact, upto, payers)
SELECT network, epoch, pay_to, count(*) FILTER (WHERE scheme = 'exact'), count(*) FILTER (WHERE scheme = 'upto'),
       count(DISTINCT payer)
  FROM settlements
 GROUP BY network, epoch, pay_to;

-- A seller's newest upto payments, read without scanning its other payments.
CREATE INDEX settlements_pay_to_scheme ON settlements (network, pay_to, epoch, scheme, ledger, tx_index);
