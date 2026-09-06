#!/usr/bin/env bash
#
# The restore drill.
#
# A backup nobody has restored is a hope, not a backup. This takes a real dump
# of the live database, restores it into a SEPARATE database, and then checks
# that what came back is actually usable — not merely that pg_restore exited 0.
#
# The four things it verifies, because each has bitten a real project:
#
#   1  Row counts match. An obvious check that catches a partial dump.
#   2  Row-level security still works. Policies and the FORCE flag are
#      properties of the table, and a restore that loses them produces a
#      database where every tenant can read every other tenant.
#   3  The audit log is still append-only. Grants are not table data; a restore
#      that hands ct_app UPDATE has silently destroyed the audit guarantee.
#   4  The monthly partitions came back. audit_log and approval_decisions are
#      partitioned, and a restore that flattens them breaks every future write.
#
# Usage:  make restore-drill
set -euo pipefail

DB_MAIN=${POSTGRES_DB:-controltower}
DB_COPY="${DB_MAIN}_drill"
OWNER=ct_migrator

# Dump and restore as the SUPERUSER, not as the schema owner.
#
# Every org-scoped table is FORCE ROW LEVEL SECURITY, and FORCE binds the table
# owner too — the same property that makes the tenant boundary trustworthy.
# `pg_dump -U ct_migrator` therefore fails outright:
#
#   ERROR: query would be affected by row-level security policy for table …
#
# It fails loudly, which is the good case. A backup script that swallowed the
# error would produce an empty file and nobody would find out until a restore.
# The superuser has BYPASSRLS and sees every tenant's rows, which is exactly
# what a backup must do and exactly why the credential is not the application's.
SUPER=${POSTGRES_SUPERUSER:-postgres}
DUMP=/tmp/ct-drill.dump

say() { printf '  %s\n' "$*"; }
fail() { printf '\n  ✘ %s\n\n' "$*" >&2; exit 1; }

say "1. dumping ${DB_MAIN} as ${SUPER} (the owner cannot: FORCE RLS binds it too)"
pg_dump -U "$SUPER" -d "$DB_MAIN" -Fc -f "$DUMP"
say "   $(du -h "$DUMP" | cut -f1)"

say "2. restoring into ${DB_COPY} (dropped first, so the drill is repeatable)"
psql -U "$SUPER" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS ${DB_COPY} WITH (FORCE)" \
  -c "CREATE DATABASE ${DB_COPY} OWNER ${OWNER}"
# --exit-on-error is the point: a restore that reports success while skipping
# half the objects is the failure mode this drill exists to catch.
pg_restore -U "$SUPER" -d "$DB_COPY" --exit-on-error "$DUMP" >/dev/null

say "3. comparing row counts"
# Counted as the superuser, which has BYPASSRLS: a backup comparison must span
# EVERY tenant, and setting a tenant context here would compare one org's rows
# and call a half-restored database healthy.
for t in progress_entries daily_reports issues audit_log users projects locations work_items; do
  A=$(psql -U "$SUPER" -d "$DB_MAIN" -tAqc "SELECT count(*) FROM app.$t" | tr -d '[:space:]')
  B=$(psql -U "$SUPER" -d "$DB_COPY" -tAqc "SELECT count(*) FROM app.$t" | tr -d '[:space:]')
  [ "$A" = "$B" ] || fail "$t: ${A} rows in the original, ${B} in the restore"
  printf '     %-18s %s\n' "$t" "$A"
done

say "4. row-level security survived"
UNPROTECTED=$(psql -U "$SUPER" -d "$DB_COPY" -tAc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app' AND c.relkind IN ('r','p')
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='app' AND table_name=c.relname AND column_name='org_id')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)" | tr -d '[:space:]')
[ "$UNPROTECTED" = "0" ] || fail "${UNPROTECTED} org-scoped tables came back without FORCE RLS"
say "   every org-scoped table has RLS enabled and forced"

say "5. the audit log is still append-only"
GRANTS=$(psql -U "$SUPER" -d "$DB_COPY" -tAc "
  SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
  WHERE table_schema='app' AND grantee='ct_app' AND table_name LIKE 'audit_log%'" | tr -d '[:space:]')
[ "$GRANTS" = "INSERT,SELECT" ] || fail "ct_app has '${GRANTS}' on the restored audit log, not INSERT,SELECT"
say "   ct_app: INSERT,SELECT — parent and every partition"

say "6. the monthly partitions came back"
PARTS=$(psql -U "$SUPER" -d "$DB_COPY" -tAc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app' AND c.relispartition AND c.relkind='r'" | tr -d '[:space:]')
[ "$PARTS" -gt 0 ] || fail "no partitions in the restore — every future audited write would fail"
say "   ${PARTS} partitions"

say "7. cleaning up"
psql -U "$SUPER" -d postgres -q -c "DROP DATABASE IF EXISTS ${DB_COPY} WITH (FORCE)"
rm -f "$DUMP"

printf '\n  ✔ Restore drill passed. The backup is a backup.\n\n'
