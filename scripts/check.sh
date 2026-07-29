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

backup_help="$(bash scripts/roomframe-backup.sh --help)"
grep -Fq 'sauvegarde age chiffrée' <<<"$backup_help" || {
  echo "La commande de sauvegarde doit annoncer le chiffrement age." >&2
  exit 1
}
grep -Fq -- '--scheduled daily|weekly' <<<"$backup_help" || {
  echo "Le cycle de sauvegarde planifié quotidien/hebdomadaire est absent." >&2
  exit 1
}
backup_key_help="$(bash scripts/roomframe-backup-key.sh --help)"
grep -Fq "refuse d'écraser" <<<"$backup_key_help" || {
  echo "L'export de l'identité de sauvegarde doit refuser tout écrasement." >&2
  exit 1
}
discovery_help="$(bash scripts/roomframe-refresh-discovery.sh --help)"
grep -Fq "ne modifie aucune adresse, route" <<<"$discovery_help" || {
  echo "La découverte locale doit préserver explicitement la configuration réseau." >&2
  exit 1
}
grep -Fq 'ECDSA-P256-SHA256' contracts/discovery.schema.json || {
  echo "Le contrat de découverte signé compatible Android 12 est absent." >&2
  exit 1
}
grep -Fq '/pki/discovery:/srv/discovery:ro' compose.yaml || {
  echo "Caddy doit recevoir uniquement le répertoire public de découverte." >&2
  exit 1
}
grep -Fq 'handle /api/v1/discovery' infra/Caddyfile || {
  echo "Le manifeste de découverte doit rester sur l'origine HTTPS unique." >&2
  exit 1
}
if rg --fixed-strings --line-number \
  'discovery_signing_key' compose.yaml services/api infra/Caddyfile; then
  echo "La clé privée de découverte ne doit être montée dans aucun conteneur." >&2
  exit 1
fi
grep -Fq '<type>_roomframe._tcp</type>' infra/avahi/roomframe.service || {
  echo "L'annonce DNS-SD RoomFrame est absente." >&2
  exit 1
}
grep -Fq 'formatVersion": 2' scripts/roomframe-backup.sh || {
  echo "Les nouvelles sauvegardes doivent utiliser le format chiffré version 2." >&2
  exit 1
}
grep -Fq 'ROOMFRAME_BACKUP_PATH=' scripts/roomframe-backup.sh || {
  echo "La sauvegarde doit publier un chemin stable pour les moteurs root." >&2
  exit 1
}
for backup_caller in \
  install.sh \
  scripts/roomframe-apply-update.sh \
  scripts/roomframe-restore.sh; do
  grep -Fq 'ROOMFRAME_BACKUP_PATH=' "$backup_caller" || {
    echo "Le consommateur de sauvegarde doit lire le chemin machine: $backup_caller" >&2
    exit 1
  }
done
for backup_consumer in \
  scripts/roomframe-verify-backup.sh \
  scripts/roomframe-restore.sh; do
  grep -Fq 'age --decrypt' "$backup_consumer" || {
    echo "La vérification et la restauration doivent matérialiser les sauvegardes age." >&2
    exit 1
  }
done
for backup_unit in \
  infra/systemd/roomframe-backup-daily.service \
  infra/systemd/roomframe-backup-daily.timer \
  infra/systemd/roomframe-backup-weekly.service \
  infra/systemd/roomframe-backup-weekly.timer; do
  [[ -f "$backup_unit" ]] || {
    echo "Unité de sauvegarde absente: $backup_unit" >&2
    exit 1
  }
done
grep -Fqx 'ExecStart=/usr/local/sbin/roomframe-backup --scheduled daily' \
  infra/systemd/roomframe-backup-daily.service || {
  echo "Le service quotidien doit exclure les médias via sa classe dédiée." >&2
  exit 1
}
grep -Fqx 'ExecStart=/usr/local/sbin/roomframe-backup --scheduled weekly' \
  infra/systemd/roomframe-backup-weekly.service || {
  echo "Le service hebdomadaire complet est absent." >&2
  exit 1
}

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

tv_certificate_broker_help="$(bash scripts/roomframe-tv-certificate-broker.sh --help)"
grep -Fq "L'API n'accède jamais à la clé privée" <<<"$tv_certificate_broker_help" || {
  echo "Le courtier de certificats doit documenter sa frontière root/API." >&2
  exit 1
}
grep -Fq 'mode verify_if_given' infra/Caddyfile || {
  echo "Caddy doit vérifier les certificats TV présentés sans bloquer l'administration." >&2
  exit 1
}
grep -Fq 'header_up -X-RoomFrame-TLS-Client-Fingerprint' infra/Caddyfile || {
  echo "Caddy doit supprimer toute empreinte TLS fournie par le client." >&2
  exit 1
}
grep -Fq 'header_up X-RoomFrame-TLS-Client-Fingerprint {tls_client_fingerprint}' \
  infra/Caddyfile || {
  echo "Caddy doit transmettre uniquement l'empreinte TLS qu'il a vérifiée." >&2
  exit 1
}
if rg --fixed-strings --line-number \
  'tv-client-ca/private' compose.yaml services/api infra/Caddyfile; then
  echo "La clé privée de la CA TV ne doit être montée dans aucun conteneur." >&2
  exit 1
fi
grep -Fq 'tvCertificateProofPayload' services/api/src/studio-routes.mjs || {
  echo "La preuve de possession de la clé privée TV est absente." >&2
  exit 1
}
server_ca_sync_help="$(bash scripts/roomframe-sync-server-ca.sh --help)"
grep -Fq "Aucune clé privée Caddy" <<<"$server_ca_sync_help" || {
  echo "La publication de CA serveur doit exclure explicitement toute clé privée." >&2
  exit 1
}
grep -Fq 'roomframe-server-ca-bootstrap-v1' \
  services/api/src/trust-bootstrap.mjs \
  contracts/tv-trust-bootstrap.schema.json || {
  echo "Le contexte d'appairage de la CA serveur doit être partagé et versionné." >&2
  exit 1
}
if rg --fixed-strings --line-number \
  'pki/authorities/local/root.key' compose.yaml services/api; then
  echo "La clé privée HTTPS Caddy ne doit être montée dans aucun conteneur applicatif." >&2
  exit 1
fi

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

if rg --line-number 'runMigrations' \
  services/api/src/app.mjs \
  services/api/src/worker.mjs \
  services/api/src/update-poller.mjs; then
  echo "Les services permanents ne doivent jamais appliquer les migrations." >&2
  exit 1
fi
grep -Fq 'ROOMFRAME_DB_USER: roomframe_runtime' compose.yaml || {
  echo "Les services applicatifs doivent utiliser le rôle PostgreSQL runtime." >&2
  exit 1
}
grep -Fq 'ROOMFRAME_DB_USER: roomframe_migrator' compose.yaml || {
  echo "Le conteneur de migration PostgreSQL dédié est absent." >&2
  exit 1
}
grep -Fq 'TO roomframe_runtime' database/migrations/0012_runtime_deployment_policy.sql || {
  echo "La table RLS de déploiement doit autoriser explicitement le runtime." >&2
  exit 1
}

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
