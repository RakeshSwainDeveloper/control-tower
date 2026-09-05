#!/bin/bash
# Runs once, on first cluster initialisation.
# Creates extensions and the least-privilege application role.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
    -- Extensions required by MVP_DATABASE_SCOPE.md
    CREATE EXTENSION IF NOT EXISTS ltree;      -- location subtree queries
    CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid, digest
    CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram text search
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    -- Application role. NOT a superuser: RLS must apply to it.
    -- (Superusers and table owners bypass RLS unless FORCE ROW LEVEL SECURITY
    --  is set; we use a non-owner role so the backstop is real.)
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CT_APP_USER}') THEN
        CREATE ROLE ${CT_APP_USER} LOGIN PASSWORD '${CT_APP_PASSWORD}';
      END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${CT_APP_USER};

    -- Migrations run as the owner (ct_migrator) so the app role never owns
    -- tables and therefore never bypasses RLS.
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ct_migrator') THEN
        CREATE ROLE ct_migrator LOGIN PASSWORD '${CT_APP_PASSWORD}';
      END IF;
    END
    \$\$;
    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ct_migrator;
    GRANT CREATE ON DATABASE ${POSTGRES_DB} TO ct_migrator;

    CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ct_migrator;
    GRANT USAGE ON SCHEMA app TO ${CT_APP_USER};
    ALTER ROLE ${CT_APP_USER} SET search_path = app, public;
    ALTER ROLE ct_migrator SET search_path = app, public;

    -- Default privileges: anything ct_migrator creates in app is usable by the
    -- app role. Deliberately excludes TRUNCATE. audit_log tightens further.
    ALTER DEFAULT PRIVILEGES FOR ROLE ct_migrator IN SCHEMA app
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${CT_APP_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ct_migrator IN SCHEMA app
      GRANT USAGE, SELECT ON SEQUENCES TO ${CT_APP_USER};

    -- ── ct_auth: the authentication bootstrap role ──────────────────
    -- Authentication must read app.users BEFORE tenant context exists, but
    -- every tenant table uses FORCE ROW LEVEL SECURITY, which binds the table
    -- OWNER too. So SECURITY DEFINER as ct_migrator is still blocked.
    --
    -- The bypass is therefore confined to one role that:
    --   · CANNOT LOG IN — no connection can ever be opened as ct_auth
    --   · owns nothing except the three resolver functions
    -- ct_app holds EXECUTE on those functions and nothing else, so it can run
    -- exactly the fixed, single-row queries they contain and no other SQL.
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ct_auth') THEN
        CREATE ROLE ct_auth NOLOGIN BYPASSRLS;
      END IF;
    END
    \$\$;
    -- CREATE is required by Postgres to transfer function ownership TO this
    -- role; it is not a capability ct_auth can use, because ct_auth is NOLOGIN
    -- and no session can ever run as it.
    GRANT USAGE, CREATE ON SCHEMA app TO ct_auth;
    -- ct_migrator must be a member of ct_auth to reassign function ownership.
    GRANT ct_auth TO ct_migrator;
SQL

echo "[init] extensions + roles created"
