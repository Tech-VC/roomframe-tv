#!/usr/bin/env bash
set -Eeuo pipefail

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
SOURCE_DEFAULTS="${ROOMFRAME_DEFAULTS_DIR:-./defaults/experience}"
SECRETS_DIR="$CONFIG_DIR/secrets"
SEED_DIR="$DATA_DIR/seed/default-experience"
RUNTIME_UID="${ROOMFRAME_RUNTIME_UID:-}"
RUNTIME_GID="${ROOMFRAME_RUNTIME_GID:-}"

fail() {
  printf 'Erreur de bootstrap: %s\n' "$*" >&2
  exit 1
}

validate_root() {
  local label="$1" value="$2" component current=""
  local -a components
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ && "$value" =~ ^/[^/]+/[^/]+ ]] \
    || fail "$label doit être un sous-répertoire absolu dédié"
  [[
    "$value" != *"/../"*
    && "$value" != */..
    && "$value" != *"/./"*
    && "$value" != */.
  ]] || fail "$label est non sûr ou pointe vers un lien symbolique"
  IFS='/' read -r -a components <<<"$value"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current}/${component}"
    [[ ! -L "$current" ]] || fail "$label traverse un lien symbolique: $current"
  done
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "exécution root requise"
[[ -f "$SOURCE_DEFAULTS/manifest.json" ]] || fail "bundle initial incomplet: $SOURCE_DEFAULTS"
validate_root ROOMFRAME_DATA_DIR "$DATA_DIR"
validate_root ROOMFRAME_CONFIG_DIR "$CONFIG_DIR"
[[ "$RUNTIME_UID" =~ ^[0-9]+$ && "$RUNTIME_GID" =~ ^[0-9]+$ ]] \
  || fail "ROOMFRAME_RUNTIME_UID et ROOMFRAME_RUNTIME_GID sont requis"
((RUNTIME_UID > 0 && RUNTIME_GID > 0)) \
  || fail "le compte runtime ne peut pas être root"

managed_paths=(
  "$DATA_DIR/app"
  "$DATA_DIR/app/recovery"
  "$DATA_DIR/postgres"
  "$DATA_DIR/media"
  "$DATA_DIR/processing"
  "$DATA_DIR/releases"
  "$DATA_DIR/backups"
  "$DATA_DIR/pki"
  "$DATA_DIR/pki/update-trust"
  "$DATA_DIR/caddy"
  "$DATA_DIR/caddy-config"
  "$DATA_DIR/seed"
  "$SEED_DIR"
  "$CONFIG_DIR/secrets"
)
for managed_path in "${managed_paths[@]}"; do
  [[ ! -L "$managed_path" ]] || fail "lien symbolique interdit dans le stockage géré: $managed_path"
done

umask 077
mkdir -p \
  "$DATA_DIR/app/recovery" \
  "$DATA_DIR/postgres" \
  "$DATA_DIR/media" \
  "$DATA_DIR/processing" \
  "$DATA_DIR/releases" \
  "$DATA_DIR/backups" \
  "$DATA_DIR/pki/update-trust" \
  "$DATA_DIR/caddy" \
  "$DATA_DIR/caddy-config" \
  "$SEED_DIR" \
  "$SECRETS_DIR"

chmod 0750 "$CONFIG_DIR" "$DATA_DIR"
chown root:root "$CONFIG_DIR" "$DATA_DIR"
chmod 0700 "$SECRETS_DIR"
chown root:root "$SECRETS_DIR"
chmod 0750 \
  "$DATA_DIR/app" \
  "$DATA_DIR/app/recovery" \
  "$DATA_DIR/media" \
  "$DATA_DIR/processing" \
  "$DATA_DIR/releases" \
  "$SEED_DIR"
chmod 0770 "$DATA_DIR/backups"
chmod 0700 "$DATA_DIR/pki"
chmod 0755 "$DATA_DIR/pki/update-trust"

create_secret_once() {
  local name="$1" bytes="$2" destination temporary
  destination="$SECRETS_DIR/$name"

  [[ ! -L "$destination" ]] || fail "un secret ne peut pas être un lien symbolique: $destination"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && -s "$destination" ]] \
      || fail "le secret existant est invalide ou vide: $destination"
    chmod 0600 "$destination"
    chown root:root "$destination"
    return
  fi

  temporary="$(mktemp "$SECRETS_DIR/.${name}.XXXXXX")"
  if ! openssl rand -hex "$bytes" >"$temporary"; then
    rm -f "$temporary"
    fail "génération du secret impossible: $name"
  fi
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -n "$temporary" "$destination"
  if [[ -e "$temporary" ]]; then
    # Une autre exécution a gagné la course; sa valeur est conservée.
    rm -f "$temporary"
  fi
  [[ -s "$destination" ]] || fail "impossible de créer le secret: $destination"
}

create_secret_once postgres_password 48
create_secret_once bootstrap_token 32
create_secret_once session_secret 48
create_secret_once totp_encryption_key 32

if [[ ! -f "$SEED_DIR/manifest.json" ]]; then
  if find "$SEED_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    fail "le répertoire de seed n'est pas vide mais ne contient pas de manifeste"
  fi
  seed_parent="$(dirname "$SEED_DIR")"
  seed_temporary="$(mktemp -d "$seed_parent/.default-experience.XXXXXX")"
  if ! cp -a "$SOURCE_DEFAULTS"/. "$seed_temporary"/; then
    find "$seed_temporary" -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$seed_temporary" 2>/dev/null || true
    fail "copie du bundle initial impossible"
  fi
  [[ -f "$seed_temporary/manifest.json" ]] || fail "manifeste absent après copie du bundle initial"
  rmdir "$SEED_DIR"
  mv "$seed_temporary" "$SEED_DIR"
fi

# L'API et le worker utilisent le compte système dédié créé par install.sh.
chown -R "${RUNTIME_UID}:${RUNTIME_GID}" \
  "$DATA_DIR/media" \
  "$DATA_DIR/processing" \
  "$DATA_DIR/releases"
chown -R root:root "$DATA_DIR/app" "$DATA_DIR/backups"
chown -R "root:${RUNTIME_GID}" "$DATA_DIR/app/recovery" "$SEED_DIR"
chmod 0750 "$DATA_DIR/app" "$DATA_DIR/app/recovery"
chmod 0700 "$DATA_DIR/backups"
chown -R root:root "$DATA_DIR/pki"
chmod -R g+rX "$SEED_DIR"
chmod -R u+rwX,go-rwx "$DATA_DIR/pki"
chown -R "root:${RUNTIME_GID}" "$DATA_DIR/pki/update-trust"
chmod -R u+rwX,g+rX,o-rwx "$DATA_DIR/pki/update-trust"

printf '%s\n' "Bootstrap persistant prêt; secrets existants et seed existant conservés."
