#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"

usage() {
  cat <<'USAGE'
Usage: sudo roomframe-update-broker

Prend au plus une demande serveur en attente dans PostgreSQL et délègue son
application à roomframe-apply-update. Si la politique opt-in l'autorise, elle
peut d'abord mettre en file une release GitHub signée suffisamment ancienne
pendant sa fenêtre de maintenance. Cette commande est destinée à l'unité
systemd RoomFrame ; l'API web ne l'exécute jamais et ne possède pas Docker.
USAGE
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}
[[ $# -eq 0 ]] || {
  usage >&2
  exit 2
}
[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "Exécution root requise." >&2
  exit 1
}
[[ -r "$RUNTIME_CONFIG" ]] || {
  echo "Configuration runtime introuvable: $RUNTIME_CONFIG" >&2
  exit 1
}

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
COMPOSE_COMMAND="${ROOMFRAME_COMPOSE_COMMAND:-$INSTALL_DIR/scripts/roomframe-compose.sh}"
APPLY_COMMAND="${ROOMFRAME_APPLY_UPDATE_COMMAND:-$INSTALL_DIR/scripts/roomframe-apply-update.sh}"
AUTO_QUEUE_SQL="$INSTALL_DIR/database/queries/queue_automatic_server_update.sql"
STATE_FILE="$DATA_DIR/app/server-update-state.json"

[[ -x "$COMPOSE_COMMAND" && -x "$APPLY_COMMAND" && -r "$AUTO_QUEUE_SQL" ]] || {
  echo "Commandes RoomFrame incomplètes." >&2
  exit 1
}

mkdir -p /run/lock
exec 8>"${ROOMFRAME_UPDATE_BROKER_LOCK_FILE:-/run/lock/roomframe-update-broker.lock}"
flock -n 8 || exit 0

# Une seconde invocation de cette unité ne peut pas coexister avec la première
# grâce au verrou ci-dessus. Un état running restant vient donc d'un processus
# interrompu avant d'avoir pu enregistrer son résultat.
"$COMPOSE_COMMAND" exec -T postgres \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet <<'SQL'
WITH interrupted AS (
  UPDATE server_update_requests
  SET status = 'failed',
      last_error_code = 'broker_interrupted',
      completed_at = now(),
      updated_at = now()
  WHERE status = 'running'
  RETURNING id, release_id
)
INSERT INTO audit_log (
  actor_type,
  action,
  target_type,
  target_id,
  details
)
SELECT
  'system',
  'release.server_apply_request_interrupted',
  'release',
  release_id::text,
  jsonb_build_object('requestId', id)
FROM interrupted;
SQL

# La sélection automatique reste entièrement dans PostgreSQL et ne reçoit
# aucun chemin ni argument venant du web. Elle ne considère que les imports
# GitHub vérifiés et n'effectue jamais de nouvelle tentative automatique.
"$COMPOSE_COMMAND" exec -T postgres \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
  < "$AUTO_QUEUE_SQL"

request_row="$(
  "$COMPOSE_COMMAND" exec -T postgres \
    psql \
      --username=roomframe \
      --dbname=roomframe \
      --tuples-only \
      --no-align \
      --field-separator=$'\t' \
      --set ON_ERROR_STOP=1 \
      --command "
        WITH candidate AS (
          SELECT id
          FROM server_update_requests
          WHERE status = 'pending'
          ORDER BY requested_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        ),
        claimed AS (
          UPDATE server_update_requests request
          SET status = 'running',
              attempt_count = request.attempt_count + 1,
              last_error_code = NULL,
              started_at = now(),
              completed_at = NULL,
              updated_at = now()
          FROM candidate
          WHERE request.id = candidate.id
          RETURNING request.id, request.release_id, request.confirmed_version
        )
        SELECT id, release_id, confirmed_version FROM claimed;
      "
)"

[[ -n "$request_row" ]] || exit 0
[[ "$(wc -l <<<"$request_row" | tr -d ' ')" == "1" ]] || {
  echo "Demande de mise à jour ambiguë." >&2
  exit 1
}
IFS=$'\t' read -r REQUEST_ID RELEASE_ID CONFIRMED_VERSION <<<"$request_row"
[[ "$REQUEST_ID" =~ ^[0-9a-f-]{36}$ && "$RELEASE_ID" =~ ^[0-9a-f-]{36}$ ]] || {
  echo "Identité de demande invalide." >&2
  exit 1
}

set +e
"$APPLY_COMMAND" \
  --release-id "$RELEASE_ID" \
  --confirm "$CONFIRMED_VERSION"
apply_status=$?
set -e

if [[ "$apply_status" -eq 0 ]]; then
  final_status="completed"
  error_code=""
elif [[ "$apply_status" -eq 75 ]]; then
  "$COMPOSE_COMMAND" exec -T postgres \
    psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
    --set=request_id="$REQUEST_ID" <<'SQL'
UPDATE server_update_requests
SET status = 'pending',
    last_error_code = 'maintenance_busy',
    started_at = NULL,
    updated_at = now()
WHERE id = :'request_id'::uuid
  AND status = 'running';
SQL
  exit 0
else
  state_status="$(
    python3 - "$STATE_FILE" "$RELEASE_ID" <<'PY'
import json
import pathlib
import sys

try:
    document = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
except (FileNotFoundError, json.JSONDecodeError, OSError):
    print("unknown")
else:
    if document.get("releaseId") != sys.argv[2]:
        print("unknown")
    else:
        print(document.get("status", "unknown"))
PY
  )"
  if [[ "$state_status" == "rolled-back" ]]; then
    final_status="rolled-back"
    error_code="code_rolled_back"
  else
    final_status="failed"
    error_code="apply_failed"
  fi
fi

"$COMPOSE_COMMAND" exec -T postgres \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
  --set=request_id="$REQUEST_ID" \
  --set=release_id="$RELEASE_ID" \
  --set=final_status="$final_status" \
  --set=error_code="$error_code" <<'SQL'
UPDATE server_update_requests
SET status = :'final_status',
    last_error_code = NULLIF(:'error_code', ''),
    completed_at = now(),
    updated_at = now()
WHERE id = :'request_id'::uuid
  AND status = 'running';

INSERT INTO audit_log (
  actor_type,
  action,
  target_type,
  target_id,
  details
) VALUES (
  'system',
  'release.server_apply_request_finished',
  'release',
  :'release_id',
  jsonb_build_object(
    'requestId', :'request_id',
    'status', :'final_status',
    'errorCode', NULLIF(:'error_code', '')
  )
);
SQL

[[ "$apply_status" -eq 0 ]]
