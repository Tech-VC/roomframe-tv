#!/usr/bin/env bash
set -Eeuo pipefail

MIGRATIONS_DIR="$(
  cd -- "${ROOMFRAME_MIGRATIONS_DIR:-$(dirname "${BASH_SOURCE[0]}")/../database/migrations}" \
    && pwd
)"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL est requis}"

command -v psql >/dev/null 2>&1 || { echo "psql est requis" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum est requis" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 est requis" >&2; exit 1; }
[[ "$MIGRATIONS_DIR" != *"'"* && "$MIGRATIONS_DIR" != *$'\n'* ]] || {
  echo "Le chemin des migrations contient un caractère non pris en charge." >&2
  exit 1
}

WORK_DIR="$(mktemp -d /tmp/roomframe-migrations.XXXXXX)"
SQL_FILE="$WORK_DIR/run.sql"
cleanup() {
  find "$WORK_DIR" -depth -type f -delete 2>/dev/null || true
  rmdir "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

cat >"$SQL_FILE" <<'SQL'
\set ON_ERROR_STOP on
SELECT pg_advisory_lock(hashtext('roomframe-schema-migrations'));
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum_sha256 text NOT NULL
);
SQL

while IFS= read -r -d '' migration; do
  filename="$(basename "$migration")"
  version="${filename%.sql}"
  [[ "$filename" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$ ]] || {
    echo "Nom de migration non sûr: $filename" >&2
    exit 1
  }
  checksum="$(sha256sum "$migration" | awk '{print $1}')"
  migration_body="$WORK_DIR/${version}.sql"
  python3 - "$migration" "$migration_body" <<'PY'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
body, begin_count = re.subn(r"^\s*BEGIN\s*;\s*", "", source, count=1, flags=re.I)
body, commit_count = re.subn(r"\s*COMMIT\s*;\s*$", "", body, count=1, flags=re.I)
if begin_count != 1 or commit_count != 1:
    raise SystemExit("Chaque migration doit être encadrée par BEGIN; et COMMIT;")
path = pathlib.Path(sys.argv[2])
path.write_text(body.rstrip() + "\n", encoding="utf-8")
path.chmod(0o600)
PY

  cat >>"$SQL_FILE" <<SQL
DO \$roomframe\$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE version = '${version}'
      AND checksum_sha256 <> '${checksum}'
  ) THEN
    RAISE EXCEPTION 'Checksum modifié pour une migration déjà appliquée: ${version}';
  END IF;
END
\$roomframe\$;
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '${version}'
) AS roomframe_apply \gset
\if :roomframe_apply
\echo Application de ${version}
BEGIN;
\ir '${migration_body}'
INSERT INTO schema_migrations(version, checksum_sha256)
VALUES ('${version}', '${checksum}');
COMMIT;
\endif
SQL
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z)

cat >>"$SQL_FILE" <<'SQL'
SELECT pg_advisory_unlock(hashtext('roomframe-schema-migrations'));
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$SQL_FILE"
