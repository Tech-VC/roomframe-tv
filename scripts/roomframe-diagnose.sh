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

for directory in app postgres media processing releases backups pki caddy caddy-config seed; do
  if [[ -d "$DATA_DIR/$directory" ]]; then
    ok "volume persistant $directory"
  else
    bad "volume persistant manquant: $DATA_DIR/$directory"
  fi
done

for secret_name in postgres_password bootstrap_token session_secret totp_encryption_key; do
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
  for service_name in caddy api worker postgres; do
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
fi

if [[ -n "${ROOMFRAME_PRIMARY_HOST:-}" && -n "${ROOMFRAME_PUBLIC_URL:-}" ]]; then
  if curl -kfsS --connect-timeout 3 \
    --resolve "${ROOMFRAME_PRIMARY_HOST}:443:127.0.0.1" \
    "${ROOMFRAME_PUBLIC_URL}/health" >/dev/null; then
    ok "API HTTPS /health"
  else
    bad "API HTTPS /health inaccessible"
  fi
fi

CA_PATH="$DATA_DIR/caddy/caddy/pki/authorities/local/root.crt"
if [[ -f "$CA_PATH" ]]; then
  ok "autorité HTTPS locale présente"
else
  bad "autorité HTTPS locale absente (normal avant le premier démarrage)"
fi

if ((failures > 0)); then
  printf '\nDiagnostic terminé avec %d erreur(s).\n' "$failures" >&2
  exit 1
fi
printf '\nDiagnostic RoomFrame réussi.\n'
