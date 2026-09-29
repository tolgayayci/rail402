-- Bazaar catalog. Listings are created from settled payments, bound to the settled payTo, and
-- versioned: every change to what a listing publishes appends an immutable row to listing_versions.
CREATE TABLE listings (
  id                  uuid PRIMARY KEY,
  sequence            bigserial   NOT NULL UNIQUE,
  network             text        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('http', 'mcp')),
  resource            text        NOT NULL,
  method              text        NOT NULL,
  tool_name           text        NOT NULL,
  scope               text        NOT NULL,
  owner               text        NOT NULL,
  trust               text        NOT NULL CHECK (trust IN ('settled', 'origin_verified')),
  state               text        NOT NULL CHECK (state IN ('published', 'quarantined')),
  version             integer     NOT NULL CHECK (version >= 1),
  content             jsonb       NOT NULL,
  content_hash        text        NOT NULL,
  first_cataloged_at  timestamptz NOT NULL,
  last_updated        timestamptz NOT NULL,
  last_settled_at     timestamptz NOT NULL,
  settlements         bigint      NOT NULL CHECK (settlements >= 0),
  UNIQUE (network, kind, resource, method, tool_name, scope)
);
CREATE INDEX listings_published_order ON listings (sequence) WHERE state = 'published';
CREATE INDEX listings_owner_created ON listings (owner, first_cataloged_at);

-- One row per published payment option, so filters match within a single option.
CREATE TABLE listing_options (
  listing_id      uuid    NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
  position        integer NOT NULL,
  scheme          text    NOT NULL,
  network         text    NOT NULL,
  asset           text    NOT NULL,
  pay_to          text    NOT NULL,
  pay_to_account  text    NOT NULL,
  amount          numeric(39, 0) NOT NULL,
  PRIMARY KEY (listing_id, position)
);
CREATE INDEX listing_options_pay_to ON listing_options (pay_to_account, network, scheme);
CREATE INDEX listing_options_network ON listing_options (network, scheme);

CREATE TABLE listing_versions (
  listing_id   uuid        NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
  version      integer     NOT NULL,
  created_at   timestamptz NOT NULL,
  cause        text        NOT NULL
               CHECK (cause IN ('settlement', 'origin_verification', 'ownership_transfer', 'quarantine')),
  transaction  text,
  owner        text        NOT NULL,
  trust        text        NOT NULL,
  state        text        NOT NULL,
  content      jsonb       NOT NULL,
  PRIMARY KEY (listing_id, version)
);

-- Settlements observed per listing; the primary key makes repeated settlements a no-op.
CREATE TABLE listing_observations (
  listing_id   uuid        NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
  transaction  text        NOT NULL,
  payer        text        NOT NULL,
  asset        text        NOT NULL,
  amount       text        NOT NULL,
  observed_at  timestamptz NOT NULL,
  PRIMARY KEY (listing_id, transaction)
);

CREATE TABLE origin_checks (
  listing_id      uuid        PRIMARY KEY REFERENCES listings (id) ON DELETE CASCADE,
  reason          text        NOT NULL CHECK (reason IN ('created', 'changed', 'owner_conflict')),
  url             text        NOT NULL,
  proposed_owner  text,
  attempts        integer     NOT NULL DEFAULT 0,
  due_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX origin_checks_due ON origin_checks (due_at);

-- Bumped on every catalog change; search indexes rebuild when it moves.
CREATE SEQUENCE catalog_revision;
