-- Run inside the Explorer database as its owner, after the first migration: the writer gets DML on
-- every table the owner creates except the migration log, the reader SELECT only. Only the owner may
-- change schema_migrations, so a compromised indexer cannot make the next migration replay.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO {{writer}}, {{reader}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {{writer}};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO {{reader}};
ALTER DEFAULT PRIVILEGES FOR ROLE {{owner}} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{writer}};
ALTER DEFAULT PRIVILEGES FOR ROLE {{owner}} IN SCHEMA public GRANT SELECT ON TABLES TO {{reader}};
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM {{writer}}, {{reader}};
