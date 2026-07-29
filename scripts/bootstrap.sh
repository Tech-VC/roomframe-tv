#!/usr/bin/env bash
set -Eeuo pipefail

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
SOURCE_DEFAULTS="${ROOMFRAME_DEFAULTS_DIR:-./defaults/experience}"
SECRETS_DIR="$CONFIG_DIR/secrets"
SEED_DIR="$DATA_DIR/seed/default-experience"
TV_CA_DIR="$DATA_DIR/pki/tv-client-ca"
TV_CA_PRIVATE_DIR="$TV_CA_DIR/private"
TV_CA_CERTIFICATE="$TV_CA_DIR/ca.crt"
TV_CA_PRIVATE_KEY="$TV_CA_PRIVATE_DIR/ca.key"
SERVER_CA_PUBLIC_DIR="$DATA_DIR/pki/server-ca"
SERVER_CA_PUBLIC_CERTIFICATE="$SERVER_CA_PUBLIC_DIR/ca.crt"
BACKUP_AGE_IDENTITY="$SECRETS_DIR/backup_age_identity"
BACKUP_KEYRING="$DATA_DIR/backup-keyring"
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
  "$BACKUP_KEYRING"
  "$DATA_DIR/pki"
  "$DATA_DIR/pki/update-trust"
  "$TV_CA_DIR"
  "$TV_CA_PRIVATE_DIR"
  "$SERVER_CA_PUBLIC_DIR"
  "$DATA_DIR/caddy"
  "$DATA_DIR/caddy-config"
  "$DATA_DIR/seed"
  "$SEED_DIR"
  "$CONFIG_DIR/secrets"
)
for managed_path in "${managed_paths[@]}"; do
  [[ ! -L "$managed_path" ]] || fail "lien symbolique interdit dans le stockage géré: $managed_path"
done
[[ ! -e "$SERVER_CA_PUBLIC_CERTIFICATE" || (
  -f "$SERVER_CA_PUBLIC_CERTIFICATE"
  && ! -L "$SERVER_CA_PUBLIC_CERTIFICATE"
) ]] || fail "copie publique de CA serveur invalide"

umask 077
mkdir -p \
  "$DATA_DIR/app/recovery" \
  "$DATA_DIR/postgres" \
  "$DATA_DIR/media" \
  "$DATA_DIR/processing" \
  "$DATA_DIR/releases" \
  "$DATA_DIR/backups" \
  "$BACKUP_KEYRING" \
  "$DATA_DIR/pki/update-trust" \
  "$TV_CA_PRIVATE_DIR" \
  "$SERVER_CA_PUBLIC_DIR" \
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
chmod 0700 "$BACKUP_KEYRING"
chmod 0700 "$DATA_DIR/pki"
chmod 0755 "$DATA_DIR/pki/update-trust"

create_secret_once() {
  local name="$1" bytes="$2" destination temporary
  destination="$SECRETS_DIR/$name"

  [[ ! -L "$destination" ]] || fail "un secret ne peut pas être un lien symbolique: $destination"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && -s "$destination" ]] \
      || fail "le secret existant est invalide ou vide: $destination"
    chmod 0444 "$destination"
    chown root:root "$destination"
    return
  fi

  temporary="$(mktemp "$SECRETS_DIR/.${name}.XXXXXX")"
  if ! openssl rand -hex "$bytes" >"$temporary"; then
    rm -f "$temporary"
    fail "génération du secret impossible: $name"
  fi
  chmod 0444 "$temporary"
  chown root:root "$temporary"
  mv -n "$temporary" "$destination"
  if [[ -e "$temporary" ]]; then
    # Une autre exécution a gagné la course; sa valeur est conservée.
    rm -f "$temporary"
  fi
  [[ -s "$destination" ]] || fail "impossible de créer le secret: $destination"
}

create_secret_once postgres_password 48
create_secret_once postgres_migrator_password 48
create_secret_once postgres_runtime_password 48
create_secret_once bootstrap_token 32
create_secret_once session_secret 48
create_secret_once totp_encryption_key 32

command -v age-keygen >/dev/null 2>&1 \
  || fail "age-keygen est requis pour protéger les sauvegardes"
if [[ -e "$BACKUP_AGE_IDENTITY" ]]; then
  [[
    -f "$BACKUP_AGE_IDENTITY"
    && -s "$BACKUP_AGE_IDENTITY"
    && ! -L "$BACKUP_AGE_IDENTITY"
  ]] || fail "l'identité age de sauvegarde existante est invalide"
else
  backup_identity_stage="$(mktemp -d "$SECRETS_DIR/.backup-age.XXXXXX")"
  if ! age-keygen -o "$backup_identity_stage/identity" >/dev/null 2>&1; then
    rmdir "$backup_identity_stage" 2>/dev/null || true
    fail "génération de l'identité age de sauvegarde impossible"
  fi
  chmod 0400 "$backup_identity_stage/identity"
  chown root:root "$backup_identity_stage/identity"
  mv -n "$backup_identity_stage/identity" "$BACKUP_AGE_IDENTITY"
  if [[ -e "$backup_identity_stage/identity" ]]; then
    rm -f "$backup_identity_stage/identity"
  fi
  rmdir "$backup_identity_stage"
fi
chmod 0400 "$BACKUP_AGE_IDENTITY"
chown root:root "$BACKUP_AGE_IDENTITY"
backup_age_recipient="$(age-keygen -y "$BACKUP_AGE_IDENTITY" 2>/dev/null)"
[[ "$backup_age_recipient" =~ ^age1[0-9a-z]+$ ]] \
  || fail "l'identité age de sauvegarde ne produit pas de destinataire X25519 valide"
backup_age_recipient_sha="$(
  printf '%s' "$backup_age_recipient" | sha256sum | awk '{print $1}'
)"
backup_keyring_identity="$BACKUP_KEYRING/$backup_age_recipient_sha.agekey"
if [[ -e "$backup_keyring_identity" ]]; then
  [[
    -f "$backup_keyring_identity"
    && -s "$backup_keyring_identity"
    && ! -L "$backup_keyring_identity"
  ]] || fail "l'identité age historique est invalide"
  keyring_recipient="$(age-keygen -y "$backup_keyring_identity" 2>/dev/null)"
  [[ "$keyring_recipient" == "$backup_age_recipient" ]] \
    || fail "collision dans le trousseau des sauvegardes"
else
  install -m 0400 -o root -g root \
    "$BACKUP_AGE_IDENTITY" "$backup_keyring_identity"
fi
chmod 0400 "$backup_keyring_identity"
chown root:root "$backup_keyring_identity"

if [[ -e "$TV_CA_PRIVATE_KEY" || -e "$TV_CA_CERTIFICATE" ]]; then
  [[
    -f "$TV_CA_PRIVATE_KEY"
    && -s "$TV_CA_PRIVATE_KEY"
    && ! -L "$TV_CA_PRIVATE_KEY"
    && -f "$TV_CA_CERTIFICATE"
    && -s "$TV_CA_CERTIFICATE"
    && ! -L "$TV_CA_CERTIFICATE"
  ]] || fail "la CA client TV persistante est incomplète; régénération automatique refusée"
else
  ca_key_temporary="$(mktemp "$TV_CA_PRIVATE_DIR/.ca-key.XXXXXX")"
  ca_certificate_temporary="$(mktemp "$TV_CA_DIR/.ca-certificate.XXXXXX")"
  if ! openssl genpkey \
    -algorithm RSA \
    -pkeyopt rsa_keygen_bits:3072 \
    -out "$ca_key_temporary" >/dev/null 2>&1 \
    || ! openssl req \
      -x509 \
      -new \
      -key "$ca_key_temporary" \
      -sha256 \
      -days 3650 \
      -subj "/CN=RoomFrame TV Client CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -out "$ca_certificate_temporary"
  then
    rm -f "$ca_key_temporary" "$ca_certificate_temporary"
    fail "génération de la CA client TV impossible"
  fi
  chmod 0600 "$ca_key_temporary"
  chmod 0644 "$ca_certificate_temporary"
  chown root:root "$ca_key_temporary" "$ca_certificate_temporary"
  mv -n "$ca_key_temporary" "$TV_CA_PRIVATE_KEY"
  mv -n "$ca_certificate_temporary" "$TV_CA_CERTIFICATE"
  if [[ -e "$ca_key_temporary" || -e "$ca_certificate_temporary" ]]; then
    rm -f "$ca_key_temporary" "$ca_certificate_temporary"
    fail "conflit pendant la création de la CA client TV"
  fi
fi

ca_key_public_sha="$(
  openssl pkey -in "$TV_CA_PRIVATE_KEY" -pubout -outform DER 2>/dev/null \
    | openssl dgst -sha256 -r \
    | awk '{print $1}'
)"
ca_certificate_public_sha="$(
  openssl x509 -in "$TV_CA_CERTIFICATE" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -r \
    | awk '{print $1}'
)"
[[ -n "$ca_key_public_sha" && "$ca_key_public_sha" == "$ca_certificate_public_sha" ]] \
  || fail "la clé privée et le certificat de la CA client TV ne correspondent pas"
openssl verify -CAfile "$TV_CA_CERTIFICATE" "$TV_CA_CERTIFICATE" >/dev/null \
  || fail "le certificat de CA client TV est invalide"

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
chown -R root:root "$DATA_DIR/app" "$DATA_DIR/backups" "$BACKUP_KEYRING"
chown -R "root:${RUNTIME_GID}" "$DATA_DIR/app/recovery" "$SEED_DIR"
chmod 0750 "$DATA_DIR/app" "$DATA_DIR/app/recovery"
chmod 0700 "$DATA_DIR/backups"
chmod 0700 "$BACKUP_KEYRING"
find "$BACKUP_KEYRING" -maxdepth 1 -type f -name '*.agekey' \
  -exec chown root:root {} + \
  -exec chmod 0400 {} +
chown -R root:root "$DATA_DIR/pki"
chmod -R g+rX "$SEED_DIR"
chmod -R u+rwX,go-rwx "$DATA_DIR/pki"
chown -R "root:${RUNTIME_GID}" "$DATA_DIR/pki/update-trust"
chmod -R u+rwX,g+rX,o-rwx "$DATA_DIR/pki/update-trust"
chown -R root:root "$TV_CA_DIR"
chmod 0755 "$TV_CA_DIR"
chmod 0700 "$TV_CA_PRIVATE_DIR"
chmod 0600 "$TV_CA_PRIVATE_KEY"
chmod 0644 "$TV_CA_CERTIFICATE"
chown root:root "$SERVER_CA_PUBLIC_DIR"
chmod 0755 "$SERVER_CA_PUBLIC_DIR"
if [[ -f "$SERVER_CA_PUBLIC_CERTIFICATE" ]]; then
  chown root:root "$SERVER_CA_PUBLIC_CERTIFICATE"
  chmod 0644 "$SERVER_CA_PUBLIC_CERTIFICATE"
fi

printf '%s\n' "Bootstrap persistant prêt; secrets existants et seed existant conservés."
