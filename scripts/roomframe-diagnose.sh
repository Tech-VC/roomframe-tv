#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
COMPOSE_COMMAND="${ROOMFRAME_COMPOSE_COMMAND:-/usr/local/sbin/roomframe-compose}"
failures=0

ok() { printf '[OK] %s\n' "$*"; }
bad() { printf '[ERREUR] %s\n' "$*" >&2; failures=$((failures + 1)); }
note() { printf '[INFO] %s\n' "$*"; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "Exécutez ce diagnostic avec sudo/root." >&2
  exit 1
}

if [[ ! -r "$RUNTIME_CONFIG" ]]; then
  bad "configuration runtime absente: $RUNTIME_CONFIG"
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
COMPOSE_COMMAND="${ROOMFRAME_COMPOSE_COMMAND:-$INSTALL_DIR/scripts/roomframe-compose.sh}"

note "RoomFrame ${ROOMFRAME_VERSION:-version inconnue}"
note "Administration: ${ROOMFRAME_PUBLIC_URL:-URL inconnue}"
note "IPv4 détectée: ${ROOMFRAME_SERVER_IP:-inconnue}"

secrets_directory="$CONFIG_DIR/secrets"
secrets_directory_mode="$(stat -c '%a' "$secrets_directory" 2>/dev/null || true)"
secrets_directory_owner="$(stat -c '%u:%g' "$secrets_directory" 2>/dev/null || true)"
if [[ "$secrets_directory_mode" == "700" && "$secrets_directory_owner" == "0:0" ]]; then
  ok "répertoire de secrets root-only (0700)"
else
  bad "protection du répertoire de secrets: ${secrets_directory_mode:-absente} ${secrets_directory_owner:-inconnue}, attendu 700 0:0"
fi

for directory in app postgres media processing releases backups backup-keyring pki caddy caddy-config seed; do
  if [[ -d "$DATA_DIR/$directory" ]]; then
    ok "volume persistant $directory"
  else
    bad "volume persistant manquant: $DATA_DIR/$directory"
  fi
done

backup_identity="$CONFIG_DIR/secrets/backup_age_identity"
if [[
  -f "$backup_identity"
  && -s "$backup_identity"
  && ! -L "$backup_identity"
  && "$(stat -c '%a:%u:%g' "$backup_identity" 2>/dev/null)" == "400:0:0"
]] && command -v age-keygen >/dev/null 2>&1 \
  && age-keygen -y "$backup_identity" 2>/dev/null | grep -Eq '^age1[0-9a-z]+$'; then
  ok "identité de sauvegarde age root-only et lisible"
  backup_recipient="$(age-keygen -y "$backup_identity" 2>/dev/null)"
  backup_recipient_sha="$(
    printf '%s' "$backup_recipient" | sha256sum | awk '{print $1}'
  )"
  keyring_identity="$DATA_DIR/backup-keyring/$backup_recipient_sha.agekey"
  if [[
    -f "$keyring_identity"
    && -s "$keyring_identity"
    && ! -L "$keyring_identity"
    && "$(stat -c '%a:%u:%g' "$keyring_identity" 2>/dev/null)" == "400:0:0"
    && "$(age-keygen -y "$keyring_identity" 2>/dev/null)" == "$backup_recipient"
  ]]; then
    ok "identité active conservée dans le trousseau de reprise"
  else
    bad "copie de l'identité active absente du trousseau de reprise"
  fi
else
  bad "identité de sauvegarde age absente, incohérente ou mal protégée"
fi

discovery_identity="$CONFIG_DIR/secrets/discovery_signing_key"
discovery_manifest="$DATA_DIR/pki/discovery/manifest.json"
discovery_verifier="$INSTALL_DIR/scripts/verify-discovery-manifest.py"
if [[
  -f "$discovery_identity"
  && -s "$discovery_identity"
  && ! -L "$discovery_identity"
  && "$(stat -c '%a:%u:%g' "$discovery_identity" 2>/dev/null)" == "400:0:0"
]] && openssl pkey -in "$discovery_identity" -check -noout >/dev/null 2>&1; then
  ok "identité de découverte ECDSA root-only"
else
  bad "identité de découverte absente, incohérente ou mal protégée"
fi
if [[ -x "$discovery_verifier" && -f "$discovery_manifest" ]] \
  && "$discovery_verifier" \
    "$discovery_manifest" \
    --expected-ip "${ROOMFRAME_SERVER_IP:-}" \
    --expected-host "${ROOMFRAME_PRIMARY_HOST:-}" >/dev/null 2>&1; then
  ok "manifeste de découverte locale signé et cohérent"
else
  bad "manifeste de découverte locale absent ou invalide"
fi

for secret_name in postgres_password postgres_migrator_password postgres_runtime_password \
  bootstrap_token session_secret totp_encryption_key; do
  secret_path="$CONFIG_DIR/secrets/$secret_name"
  if [[ ! -f "$secret_path" || ! -s "$secret_path" || -L "$secret_path" ]]; then
    bad "secret absent, vide ou non régulier: $secret_name"
    continue
  fi
  mode="$(stat -c '%a' "$secret_path" 2>/dev/null || true)"
  owner="$(stat -c '%u:%g' "$secret_path" 2>/dev/null || true)"
  if [[ "$mode" == "444" && "$owner" == "0:0" ]]; then
    ok "secret $secret_name protégé par le répertoire root-only et montable en lecture seule (0444)"
  else
    bad "protection du secret $secret_name: ${mode:-inconnue} ${owner:-inconnu}, attendu 444 0:0"
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  bad "Docker est introuvable"
elif ! docker info >/dev/null 2>&1; then
  bad "le démon Docker ne répond pas"
else
  ok "Docker répond"
fi

if [[ ! -x "$COMPOSE_COMMAND" ]]; then
  bad "commande Compose RoomFrame introuvable: $COMPOSE_COMMAND"
elif "$COMPOSE_COMMAND" config --quiet >/dev/null 2>&1; then
  ok "configuration Compose valide"
else
  bad "configuration Compose invalide"
fi

if [[ -x "$COMPOSE_COMMAND" ]]; then
  note "État des services:"
  "$COMPOSE_COMMAND" ps 2>&1 || bad "impossible de lire l'état des services"
  for service_name in caddy api worker update-poller postgres; do
    container_id="$("$COMPOSE_COMMAND" ps -q "$service_name" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      bad "conteneur absent: $service_name"
      continue
    fi
    service_status="$(
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container_id" 2>/dev/null || true
    )"
    case "$service_status" in
      healthy|running) ok "service $service_name: $service_status" ;;
      *) bad "service $service_name: ${service_status:-état inconnu}" ;;
    esac
  done
  for service_name in database-roles migrate; do
    container_id="$("$COMPOSE_COMMAND" ps -a -q "$service_name" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      bad "étape d'initialisation absente: $service_name"
      continue
    fi
    setup_status="$(
      docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' \
        "$container_id" 2>/dev/null || true
    )"
    if [[ "$setup_status" == "exited:0" ]]; then
      ok "étape d'initialisation $service_name terminée"
    else
      bad "étape d'initialisation $service_name: ${setup_status:-état inconnu}"
    fi
  done
  database_privileges="$(
    "$COMPOSE_COMMAND" exec -T postgres \
      psql \
        --username=roomframe \
        --dbname=roomframe \
        --tuples-only \
        --no-align \
        --set ON_ERROR_STOP=1 \
        --command "
          SELECT
            pg_get_userbyid(datdba) = 'roomframe_owner',
            has_schema_privilege('roomframe_runtime', 'public', 'USAGE'),
            NOT has_schema_privilege('roomframe_runtime', 'public', 'CREATE'),
            NOT has_table_privilege(
              'roomframe_runtime',
              'public.schema_migrations',
              'SELECT'
            )
          FROM pg_database
          WHERE datname = current_database();
        " 2>/dev/null || true
  )"
  if [[ "$database_privileges" == "t|t|t|t" ]]; then
    ok "rôles PostgreSQL propriétaire/migration/runtime séparés"
  else
    bad "séparation des privilèges PostgreSQL non confirmée"
  fi
  server_update_counts="$(
    "$COMPOSE_COMMAND" exec -T postgres \
      psql \
        --username=roomframe \
        --dbname=roomframe \
        --tuples-only \
        --no-align \
        --set ON_ERROR_STOP=1 \
        --command "
          SELECT
            count(*) FILTER (WHERE status = 'pending'),
            count(*) FILTER (WHERE status = 'running')
          FROM server_update_requests;
        " 2>/dev/null || true
  )"
  if [[ "$server_update_counts" =~ ^[0-9]+\|[0-9]+$ ]]; then
    note "Demandes serveur en attente/en cours: $server_update_counts"
  else
    bad "impossible de lire la file de mises à jour serveur"
  fi
fi

if [[ -d /run/systemd/system ]]; then
  if systemctl is-enabled roomframe-update-broker.timer >/dev/null 2>&1 \
    && systemctl is-active roomframe-update-broker.timer >/dev/null 2>&1; then
    ok "timer du courtier de mises à jour actif"
  else
    bad "timer du courtier de mises à jour inactif"
  fi
  if systemctl is-enabled roomframe-tv-certificate-broker.timer >/dev/null 2>&1 \
    && systemctl is-active roomframe-tv-certificate-broker.timer >/dev/null 2>&1; then
    ok "timer du courtier de certificats TV actif"
  else
    bad "timer du courtier de certificats TV inactif"
  fi
  for backup_timer in roomframe-backup-daily.timer roomframe-backup-weekly.timer; do
    if systemctl is-enabled "$backup_timer" >/dev/null 2>&1 \
      && systemctl is-active "$backup_timer" >/dev/null 2>&1; then
      ok "timer de sauvegarde actif: $backup_timer"
    else
      bad "timer de sauvegarde inactif: $backup_timer"
    fi
  done
  if [[ "${ROOMFRAME_DISCOVERY_AVAHI_ENABLED:-0}" == "1" ]]; then
    if systemctl is-enabled avahi-daemon >/dev/null 2>&1 \
      && systemctl is-active avahi-daemon >/dev/null 2>&1 \
      && [[ -f /etc/avahi/services/roomframe.service ]] \
      && ! [[ -L /etc/avahi/services/roomframe.service ]]; then
      ok "annonce locale Avahi _roomframe._tcp active"
    else
      bad "annonce locale Avahi activée mais indisponible"
    fi
  else
    note "découverte Avahi désactivée; URL IP et saisie manuelle conservées"
  fi
fi

if [[ -n "${ROOMFRAME_PRIMARY_HOST:-}" && -n "${ROOMFRAME_PUBLIC_URL:-}" ]]; then
  if curl -kfsS --connect-timeout 3 \
    --resolve "${ROOMFRAME_PRIMARY_HOST}:443:127.0.0.1" \
    "${ROOMFRAME_PUBLIC_URL}/health" >/dev/null; then
    ok "API HTTPS /health"
  else
    bad "API HTTPS /health inaccessible"
  fi
  discovery_http_sha="$(
    curl -kfsS --connect-timeout 3 \
      --resolve "${ROOMFRAME_PRIMARY_HOST}:443:127.0.0.1" \
      "${ROOMFRAME_PUBLIC_URL}/api/v1/discovery" 2>/dev/null \
      | sha256sum | awk '{print $1}' \
      || true
  )"
  discovery_disk_sha="$(
    sha256sum "$discovery_manifest" 2>/dev/null | awk '{print $1}' || true
  )"
  if [[ -n "$discovery_disk_sha" && "$discovery_http_sha" == "$discovery_disk_sha" ]]; then
    ok "manifeste de découverte servi sur l'origine HTTPS unique"
  else
    bad "manifeste de découverte HTTPS absent ou désynchronisé"
  fi
fi

CA_PATH="$DATA_DIR/caddy/caddy/pki/authorities/local/root.crt"
if [[ -f "$CA_PATH" ]]; then
  ok "autorité HTTPS locale présente"
else
  bad "autorité HTTPS locale absente (normal avant le premier démarrage)"
fi

SERVER_CA_PUBLIC="$DATA_DIR/pki/server-ca/ca.crt"
if [[
  -f "$CA_PATH"
  && -f "$SERVER_CA_PUBLIC"
  && ! -L "$SERVER_CA_PUBLIC"
  && "$(stat -c '%a:%u:%g' "$SERVER_CA_PUBLIC" 2>/dev/null)" == "644:0:0"
]] && cmp -s "$CA_PATH" "$SERVER_CA_PUBLIC"; then
  ok "CA HTTPS publique disponible pour l’appairage chiffré des TV"
else
  bad "copie publique de la CA HTTPS absente ou désynchronisée"
fi

TV_CA_CERTIFICATE="$DATA_DIR/pki/tv-client-ca/ca.crt"
TV_CA_PRIVATE_KEY="$DATA_DIR/pki/tv-client-ca/private/ca.key"
if [[
  -f "$TV_CA_CERTIFICATE"
  && -s "$TV_CA_CERTIFICATE"
  && "$(stat -c '%a:%u:%g' "$TV_CA_CERTIFICATE" 2>/dev/null)" == "644:0:0"
  && -f "$TV_CA_PRIVATE_KEY"
  && -s "$TV_CA_PRIVATE_KEY"
  && "$(stat -c '%a:%u:%g' "$TV_CA_PRIVATE_KEY" 2>/dev/null)" == "600:0:0"
]] && openssl verify -CAfile "$TV_CA_CERTIFICATE" "$TV_CA_CERTIFICATE" >/dev/null 2>&1; then
  ok "CA cliente TV persistante, publique et clé privée root-only"
else
  bad "CA cliente TV absente, incohérente ou mal protégée"
fi

if ((failures > 0)); then
  printf '\nDiagnostic terminé avec %d erreur(s).\n' "$failures" >&2
  exit 1
fi
printf '\nDiagnostic RoomFrame réussi.\n'
