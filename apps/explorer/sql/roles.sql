-- Explorer database and roles. Run once per Postgres cluster as a superuser, replacing the names in
-- double braces; set the passwords separately (ALTER ROLE ... PASSWORD). Then run grants.sql inside
-- the Explorer database and migrate it as the owner.
--
--   {{owner}}     owns the schema; used only to migrate
--   {{writer}}    the indexer: reads and writes the Explorer tables
--   {{reader}}    the public pages and API: SELECT only, read-only transactions, short statements
--   {{database}}  the Explorer database
--   {{facilitator_database}}  the facilitator's database, which no Explorer role may connect to

CREATE ROLE {{owner}} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
CREATE ROLE {{writer}} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
CREATE ROLE {{reader}} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
ALTER ROLE {{reader}} SET default_transaction_read_only = on;
ALTER ROLE {{reader}} SET statement_timeout = '2s';
ALTER ROLE {{reader}} SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE {{writer}} SET statement_timeout = '120s';

CREATE DATABASE {{database}} OWNER {{owner}};
REVOKE ALL ON DATABASE {{database}} FROM PUBLIC;
GRANT CONNECT ON DATABASE {{database}} TO {{writer}}, {{reader}};

-- Without this, every role can connect to the facilitator's database by default. Grant CONNECT to
-- the facilitator's own roles explicitly before running it.
REVOKE CONNECT ON DATABASE {{facilitator_database}} FROM PUBLIC;
