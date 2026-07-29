#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"

usage() {
  cat <<'USAGE'
Usage: sudo roomframe-tv-certificate-broker

Prend au plus une demande de certificat TV, émet un certificat client avec la
CA root-only de l'instance, puis publie uniquement le certificat public dans
PostgreSQL. L'API n'accède jamais à la clé privée de cette CA.
USAGE
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}
[[ $# -eq 0 ]] || { usage >&2; exit 2; }
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
ISSUE_COMMAND="${ROOMFRAME_TV_CERTIFICATE_ISSUE_COMMAND:-$INSTALL_DIR/scripts/issue-tv-certificate.sh}"
CA_DIR="$DATA_DIR/pki/tv-client-ca"
CA_CERTIFICATE="$CA_DIR/ca.crt"
CA_PRIVATE_KEY="$CA_DIR/private/ca.key"

[[ -x "$COMPOSE_COMMAND" && -x "$ISSUE_COMMAND" ]] || {
  echo "Commandes RoomFrame incomplètes." >&2
  exit 1
}
[[ -f "$CA_CERTIFICATE" && -s "$CA_CERTIFICATE" && ! -L "$CA_CERTIFICATE" ]] || {
  echo "Certificat de CA TV absent ou invalide." >&2
  exit 1
}
[[ -f "$CA_PRIVATE_KEY" && -s "$CA_PRIVATE_KEY" && ! -L "$CA_PRIVATE_KEY" ]] || {
  echo "Clé privée de CA TV absente ou invalide." >&2
  exit 1
}

mkdir -p /run/lock
exec 8>"${ROOMFRAME_TV_CERTIFICATE_BROKER_LOCK_FILE:-/run/lock/roomframe-tv-certificate-broker.lock}"
flock -n 8 || exit 0

"$COMPOSE_COMMAND" exec -T postgres \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet <<'SQL'
UPDATE tv_certificate_requests
SET status = 'pending',
    started_at = NULL,
    last_error_code = 'broker_interrupted',
    updated_at = now()
WHERE status = 'issuing'
  AND started_at < now() - interval '5 minutes';
SQL

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
          FROM tv_certificate_requests
          WHERE status = 'pending' AND attempt_count < 10
          ORDER BY requested_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        ),
        claimed AS (
          UPDATE tv_certificate_requests request
          SET status = 'issuing',
              attempt_count = request.attempt_count + 1,
              started_at = now(),
              last_error_code = NULL,
              updated_at = now()
          FROM candidate
          WHERE request.id = candidate.id
          RETURNING
            request.id,
            request.screen_id,
            replace(encode(request.public_key_spki, 'base64'), E'\\n', '')
              AS public_key_b64
        )
        SELECT id, screen_id, public_key_b64 FROM claimed;
      "
)"

[[ -n "$request_row" ]] || exit 0
[[ "$(wc -l <<<"$request_row" | tr -d ' ')" == "1" ]] || {
  echo "Demande de certificat ambiguë." >&2
  exit 1
}
IFS=$'\t' read -r REQUEST_ID SCREEN_ID PUBLIC_KEY_B64 <<<"$request_row"
[[ "$REQUEST_ID" =~ ^[0-9a-f-]{36}$ && "$SCREEN_ID" =~ ^[0-9a-f-]{36}$ ]] || {
  echo "Identité de demande invalide." >&2
  exit 1
}
[[ "$PUBLIC_KEY_B64" =~ ^[A-Za-z0-9+/=]+$ ]] || {
  echo "Clé publique encodée invalide." >&2
  exit 1
}

temporary="$(mktemp -d /tmp/roomframe-tv-broker.XXXXXX)"
cleanup() {
  find "$temporary" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "$temporary" 2>/dev/null || true
}
trap cleanup EXIT
public_key="$temporary/public.der"
certificate="$temporary/client.crt"
printf '%s' "$PUBLIC_KEY_B64" | base64 --decode >"$public_key"
serial="$(openssl rand -hex 16 | tr '[:lower:]' '[:upper:]')"

set +e
metadata="$(
  "$ISSUE_COMMAND" \
    --public-key-der "$public_key" \
    --ca-certificate "$CA_CERTIFICATE" \
    --ca-private-key "$CA_PRIVATE_KEY" \
    --screen-id "$SCREEN_ID" \
    --serial "$serial" \
    --output "$certificate"
)"
issue_status=$?
set -e

if [[ "$issue_status" -ne 0 ]]; then
  "$COMPOSE_COMMAND" exec -T postgres \
    psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
      --set=request_id="$REQUEST_ID" <<'SQL'
UPDATE tv_certificate_requests
SET status = CASE WHEN attempt_count >= 10 THEN 'failed' ELSE 'pending' END,
    last_error_code = 'certificate_issue_failed',
    started_at = NULL,
    updated_at = now()
WHERE id = :'request_id'::uuid
  AND status = 'issuing';
SQL
  exit "$issue_status"
fi

IFS=$'\t' read -r FINGERPRINT SERIAL EXPIRES_AT <<<"$metadata"
[[ "$FINGERPRINT" =~ ^[a-f0-9]{64}$ && "$SERIAL" =~ ^[A-F0-9]{2,40}$ ]] || {
  echo "Métadonnées de certificat invalides." >&2
  exit 1
}
CERTIFICATE_B64="$(base64 <"$certificate" | tr -d '\r\n')"

"$COMPOSE_COMMAND" exec -T postgres \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
    --set=request_id="$REQUEST_ID" \
    --set=screen_id="$SCREEN_ID" \
    --set=certificate_b64="$CERTIFICATE_B64" \
    --set=fingerprint="$FINGERPRINT" \
    --set=serial="$SERIAL" \
    --set=expires_at="$EXPIRES_AT" <<'SQL'
BEGIN;

UPDATE tv_certificate_requests
SET status = 'issued',
    certificate_pem = convert_from(decode(:'certificate_b64', 'base64'), 'UTF8'),
    certificate_fingerprint_sha256 = :'fingerprint',
    certificate_serial = :'serial',
    issued_at = now(),
    expires_at = :'expires_at'::timestamptz,
    started_at = NULL,
    last_error_code = NULL,
    updated_at = now()
WHERE id = :'request_id'::uuid
  AND screen_id = :'screen_id'::uuid
  AND status = 'issuing'
  AND EXISTS (
    SELECT 1 FROM screens
    WHERE screens.id = tv_certificate_requests.screen_id
      AND screens.enrollment_state = 'active'
  );

UPDATE screens
SET client_certificate_pending_fingerprint = :'fingerprint',
    client_certificate_pending_serial = :'serial',
    client_certificate_pending_issued_at = now(),
    client_certificate_pending_expires_at = :'expires_at'::timestamptz,
    client_certificate_pending_required_at = now() + interval '24 hours',
    client_certificate_revoked_at = NULL,
    updated_at = now()
WHERE id = :'screen_id'::uuid
  AND enrollment_state = 'active'
  AND EXISTS (
    SELECT 1
    FROM tv_certificate_requests
    WHERE id = :'request_id'::uuid
      AND screen_id = screens.id
      AND status = 'issued'
  );

UPDATE tv_certificate_requests
SET status = 'revoked',
    started_at = NULL,
    last_error_code = 'tv_not_active',
    updated_at = now()
WHERE id = :'request_id'::uuid
  AND status = 'issuing';

INSERT INTO audit_log (
  actor_type,
  action,
  target_type,
  target_id,
  details
) SELECT
  'system',
  'tv.certificate.issued',
  'tv',
  :'screen_id',
  jsonb_build_object(
    'requestId', :'request_id',
    'fingerprintSha256', :'fingerprint',
    'serial', :'serial',
    'expiresAt', :'expires_at'
  )
FROM screens
WHERE id = :'screen_id'::uuid
  AND client_certificate_pending_fingerprint = :'fingerprint';

COMMIT;
SQL
