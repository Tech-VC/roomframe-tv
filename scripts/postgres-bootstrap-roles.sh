#!/bin/sh
set -eu

database_host="${ROOMFRAME_DB_HOST:-postgres}"
database_port="${ROOMFRAME_DB_PORT:-5432}"
database_name="${ROOMFRAME_DB_NAME:-roomframe}"
admin_user="${ROOMFRAME_DB_ADMIN_USER:-roomframe}"
admin_password_file="${ROOMFRAME_DB_ADMIN_PASSWORD_FILE:-/run/secrets/postgres_password}"
pgpass_file="/tmp/roomframe-admin.pgpass"

case "$database_host" in
  *:*|*\\*|*'
'*) echo "Hôte PostgreSQL invalide." >&2; exit 1 ;;
esac
case "$database_port" in
  ''|*[!0-9]*) echo "Port PostgreSQL invalide." >&2; exit 1 ;;
esac
case "$database_name" in
  ''|*[!a-zA-Z0-9_]*) echo "Nom de base PostgreSQL invalide." >&2; exit 1 ;;
esac
case "$admin_user" in
  ''|*[!a-zA-Z0-9_]*) echo "Rôle administrateur PostgreSQL invalide." >&2; exit 1 ;;
esac

[ -f "$admin_password_file" ] && [ -s "$admin_password_file" ] || {
  echo "Secret administrateur PostgreSQL absent." >&2
  exit 1
}

umask 077
admin_password="$(tr -d '\r\n' <"$admin_password_file")"
case "$admin_password" in
  ''|*[!0-9a-fA-F]*) echo "Secret administrateur PostgreSQL invalide." >&2; exit 1 ;;
esac
printf '%s:%s:*:%s:%s\n' \
  "$database_host" "$database_port" "$admin_user" "$admin_password" >"$pgpass_file"
unset admin_password
export PGPASSFILE="$pgpass_file"

cleanup() {
  rm -f "$pgpass_file"
}
trap cleanup EXIT HUP INT TERM

psql \
  --host="$database_host" \
  --port="$database_port" \
  --username="$admin_user" \
  --dbname="$database_name" \
  --no-password \
  --set=database_name="$database_name" \
  --set ON_ERROR_STOP=1 \
  --quiet <<'SQL'
BEGIN;

DO $roomframe_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roomframe_owner') THEN
    CREATE ROLE roomframe_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roomframe_migrator') THEN
    CREATE ROLE roomframe_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roomframe_runtime') THEN
    CREATE ROLE roomframe_runtime LOGIN;
  END IF;
END
$roomframe_roles$;

ALTER ROLE roomframe_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER ROLE roomframe_migrator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER ROLE roomframe_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

DO $roomframe_migrator_membership$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE roleid = 'roomframe_owner'::regrole
      AND member = 'roomframe_migrator'::regrole
  ) THEN
    EXECUTE 'GRANT roomframe_owner TO roomframe_migrator';
  END IF;
END
$roomframe_migrator_membership$;
DO $roomframe_runtime_membership$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE roleid = 'roomframe_owner'::regrole
      AND member = 'roomframe_runtime'::regrole
  ) THEN
    EXECUTE 'REVOKE roomframe_owner FROM roomframe_runtime';
  END IF;
END
$roomframe_runtime_membership$;

SELECT format(
  'ALTER ROLE roomframe_migrator PASSWORD %L',
  rtrim(pg_read_file('/run/secrets/postgres_migrator_password'), E'\r\n')
)
\gexec
SELECT format(
  'ALTER ROLE roomframe_runtime PASSWORD %L',
  rtrim(pg_read_file('/run/secrets/postgres_runtime_password'), E'\r\n')
)
\gexec

SELECT format('ALTER DATABASE %I OWNER TO roomframe_owner', :'database_name')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', :'database_name')
\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO roomframe_migrator, roomframe_runtime',
  :'database_name'
)
\gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO roomframe_owner;
GRANT USAGE ON SCHEMA public TO roomframe_runtime;

DO $roomframe_ownership$
DECLARE
  object record;
BEGIN
  FOR object IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS object_name,
      relation.relkind AS object_kind
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND owner_role.rolname = 'roomframe'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    CASE object.object_kind
      WHEN 'v' THEN
        EXECUTE format(
          'ALTER VIEW %I.%I OWNER TO roomframe_owner',
          object.schema_name,
          object.object_name
        );
      WHEN 'm' THEN
        EXECUTE format(
          'ALTER MATERIALIZED VIEW %I.%I OWNER TO roomframe_owner',
          object.schema_name,
          object.object_name
        );
      WHEN 'f' THEN
        EXECUTE format(
          'ALTER FOREIGN TABLE %I.%I OWNER TO roomframe_owner',
          object.schema_name,
          object.object_name
        );
      ELSE
        EXECUTE format(
          'ALTER TABLE %I.%I OWNER TO roomframe_owner',
          object.schema_name,
          object.object_name
        );
    END CASE;
  END LOOP;

  -- Une séquence SERIAL/IDENTITY doit changer de propriétaire avec sa table.
  -- Après les tables, seules les séquences autonomes encore détenues par
  -- l'ancien rôle restent à transférer.
  FOR object IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS object_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND owner_role.rolname = 'roomframe'
      AND relation.relkind = 'S'
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE %I.%I OWNER TO roomframe_owner',
      object.schema_name,
      object.object_name
    );
  END LOOP;

  FOR object IN
    SELECT routine.oid::regprocedure AS signature
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_roles owner_role ON owner_role.oid = routine.proowner
    WHERE namespace.nspname = 'public'
      AND owner_role.rolname = 'roomframe'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO roomframe_owner', object.signature);
  END LOOP;
END
$roomframe_ownership$;

ALTER DEFAULT PRIVILEGES FOR ROLE roomframe_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO roomframe_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE roomframe_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO roomframe_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE roomframe_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO roomframe_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO roomframe_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
  TO roomframe_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO roomframe_runtime;

DO $roomframe_schema_migrations$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM roomframe_runtime;
  END IF;
END
$roomframe_schema_migrations$;

COMMIT;
SQL

printf '%s\n' "Rôles PostgreSQL RoomFrame prêts."
