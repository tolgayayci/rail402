-- Shared rate limiting: one fixed one-minute window per client key.
CREATE TABLE rate_limit_windows (
  key           text        NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer     NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Metering: daily usage per caller subject (an API key id, or "public" for keyless access).
CREATE TABLE usage_daily (
  subject         text    NOT NULL,
  day             date    NOT NULL,
  network         text    NOT NULL,
  operation       text    NOT NULL CHECK (operation IN ('verify', 'settle')),
  outcome         text    NOT NULL,
  asset           text    NOT NULL,
  requests        bigint  NOT NULL,
  settled_amount  numeric(60, 0) NOT NULL,
  PRIMARY KEY (subject, day, network, operation, outcome, asset)
);
