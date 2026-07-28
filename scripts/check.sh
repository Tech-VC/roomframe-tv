#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_BIN="${ROOMFRAME_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
[[ -x "$NODE_BIN" ]] || {
  echo "Node.js 22 ou plus récent est requis." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "Python 3 est requis." >&2
  exit 1
}

if find . \
  \( -path './.git' -o -path './services/api/node_modules' \
     -o -path './apps/tv-android/.gradle' -o -path './apps/tv-android/app/build' \
     -o -path './local-branding' -o -path './local-hardware' \) -prune \
  -o -type f \( -name '._*' -o -name '.DS_Store' \) -print -quit \
  | grep -q .; then
  echo "Des métadonnées macOS .DS_Store ou AppleDouble ._* sont présentes dans les sources." >&2
  exit 1
fi

bash -n install.sh
while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find scripts -maxdepth 1 -type f -name '*.sh' -print0)

restore_help="$(bash scripts/roomframe-restore.sh --help)"
grep -Fq 'Aucun raccourci --latest' <<<"$restore_help" || {
  echo "L'aide de restauration doit annoncer le refus de --latest." >&2
  exit 1
}
if bash scripts/roomframe-restore.sh --latest >/dev/null 2>&1; then
  echo "La restauration ne doit jamais accepter --latest." >&2
  exit 1
fi

apply_help="$(bash scripts/roomframe-apply-update.sh --help)"
grep -Fq "n'est jamais appelée directement par l'API web" <<<"$apply_help" || {
  echo "L'aide d'application doit documenter sa frontière root/API." >&2
  exit 1
}
if rg -n 'realpath .*RELEASE_PATH|read -r .*RELEASE_PATH' scripts/roomframe-apply-update.sh; then
  echo "Le moteur root ne doit pas faire confiance au chemin de release stocké par l'API." >&2
  exit 1
fi
grep -Fq "realpath -e \"\$VERIFIED_ROOT/\$RELEASE_SHA.rfupdate\"" \
  scripts/roomframe-apply-update.sh || {
  echo "Le moteur root doit dériver le bundle hôte depuis sa quarantaine et son hash." >&2
  exit 1
}

broker_help="$(bash scripts/roomframe-update-broker.sh --help)"
grep -Fq "l'API web ne l'exécute jamais" <<<"$broker_help" || {
  echo "L'aide du courtier doit documenter sa frontière root/API." >&2
  exit 1
}
automatic_queue_sql="database/queries/queue_automatic_server_update.sql"
grep -Fq "release.verification #>> '{source,provider}' = 'github'" "$automatic_queue_sql" || {
  echo "La file automatique doit être limitée aux imports GitHub vérifiés." >&2
  exit 1
}
grep -Fq "WHERE previous.release_id = release.id" "$automatic_queue_sql" || {
  echo "Une release déjà tentée ne doit jamais être relancée automatiquement." >&2
  exit 1
}
grep -Fq 'AUTO_QUEUE_SQL=' scripts/roomframe-update-broker.sh || {
  echo "Le courtier doit charger la requête automatique versionnée." >&2
  exit 1
}

trust_key_help="$(bash scripts/roomframe-trust-update-key.sh --help)"
grep -Fq -- '--revoke' <<<"$trust_key_help" || {
  echo "La commande de confiance doit documenter la révocation par empreinte." >&2
  exit 1
}

broker_unit="infra/systemd/roomframe-update-broker.service"
grep -Eq '^RestrictAddressFamilies=.*AF_NETLINK([[:space:]]|$)' "$broker_unit" || {
  echo "La sandbox du courtier doit autoriser AF_NETLINK pour la détection réseau." >&2
  exit 1
}
grep -Fqx 'Environment=DOCKER_CONFIG=/run/roomframe-update-broker/docker' "$broker_unit" || {
  echo "Le client Docker du courtier doit écrire dans son répertoire runtime éphémère." >&2
  exit 1
}
grep -Fqx 'ProtectHome=true' "$broker_unit" || {
  echo "La sandbox du courtier doit conserver ProtectHome=true." >&2
  exit 1
}

while IFS= read -r -d '' document; do
  python3 -m json.tool "$document" >/dev/null
done < <(find contracts defaults examples -type f -name '*.json' -print0)

python3 scripts/verify-experience-bundle.py \
  bundles/roomframe-default-experience-1.0.0.rfbundle

(
  cd services/api
  "$NODE_BIN" scripts/check-syntax.mjs
)

while IFS= read -r -d '' script; do
  "$NODE_BIN" --check "$script"
done < <(find prototype -type f -name '*.js' -print0)

if rg --pcre2 --line-number '<script(?![^>]*\bsrc=)|<style(?:\s|>)|style=' \
  prototype/admin prototype/tv; then
  echo "La CSP stricte interdit les scripts/styles inline dans les interfaces." >&2
  exit 1
fi
if rg --line-number \
  'innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function' \
  prototype/admin prototype/tv; then
  echo "Les interfaces ne doivent pas interpréter de contenu dynamique comme HTML ou JavaScript." >&2
  exit 1
fi

if rg --fixed-strings --line-number '/var/run/docker.sock' compose.yaml; then
  echo "Le socket Docker ne doit jamais être monté dans les conteneurs applicatifs." >&2
  exit 1
fi

compose=()
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
fi
if ((${#compose[@]} > 0)); then
  COMPOSE_DISABLE_ENV_FILE=1 \
  ROOMFRAME_VERSION=check \
  ROOMFRAME_INSTALL_DIR=/opt/roomframe \
  ROOMFRAME_CONFIG_DIR=/tmp/roomframe-check-config \
  ROOMFRAME_DATA_DIR=/tmp/roomframe-check-data \
  ROOMFRAME_SERVER_IP=192.0.2.20 \
  ROOMFRAME_PRIMARY_HOST=roomframe.example.test \
  ROOMFRAME_PUBLIC_URL=https://roomframe.example.test \
  ROOMFRAME_PREFERRED_URL=https://roomframe.example.test \
  ROOMFRAME_FALLBACK_URL=https://192.0.2.20 \
  ROOMFRAME_API_URL=https://roomframe.example.test/api \
  ROOMFRAME_TIMEZONE=UTC \
  ROOMFRAME_RUNTIME_UID=991 \
  ROOMFRAME_RUNTIME_GID=991 \
    "${compose[@]}" --env-file /dev/null -f compose.yaml config --quiet
fi

printf '%s\n' "Checks RoomFrame réussis."
