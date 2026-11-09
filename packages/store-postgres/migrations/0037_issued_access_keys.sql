-- Access keys issued to signed-in GitHub accounts: one row per account, its current key's digest only.
-- Signing in again replaces the key; the replaced digest is gone, so the old key stops working.
CREATE TABLE issued_access_keys (
  id                               text        PRIMARY KEY,
  github_user_id                   bigint      NOT NULL UNIQUE,
  github_login                     text        NOT NULL,
  sha256                           text        NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  networks                         text[]      NOT NULL,
  requests_per_minute              integer     NOT NULL CHECK (requests_per_minute > 0),
  sponsor_budget_stroops_per_hour  bigint      NOT NULL CHECK (sponsor_budget_stroops_per_hour > 0),
  created_at                       timestamptz NOT NULL,
  expires_at                       timestamptz NOT NULL CHECK (expires_at > created_at),
  issued_count                     integer     NOT NULL DEFAULT 1,
  revoked                          boolean     NOT NULL DEFAULT false
);

-- Keys issued in the last hour, for the service-wide cap on new keys.
CREATE INDEX issued_access_keys_created ON issued_access_keys (created_at);
