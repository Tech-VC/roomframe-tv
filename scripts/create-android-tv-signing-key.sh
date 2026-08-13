#!/usr/bin/env bash
set -Eeuo pipefail
set +x

# Crée une seule fois la clé Android de production hors dépôt. Le secret est
# généré localement, transmis à keytool par variable d'environnement puis
# enregistré dans le Trousseau sans jamais être placé sur la ligne de commande.

ROOMFRAME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIGNING_ALIAS="roomframe-tv-production-v1"
KEYCHAIN_SERVICE="RoomFrame Android Signing Store Password"
KEYCHAIN_ACCOUNT="$SIGNING_ALIAS"
SIGNING_DIRECTORY="${ROOMFRAME_ANDROID_SIGNING_DIRECTORY:-$HOME/Library/Application Support/RoomFrame/signing}"
SIGNING_STORE="$SIGNING_DIRECTORY/$SIGNING_ALIAS.p12"
JDK_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
KEYTOOL="$JDK_HOME/bin/keytool"
PINNED_CERTIFICATE="$ROOMFRAME_ROOT/apps/tv-android/signing-certificate-sha256.txt"
CREATED_STORE=false
CREATED_KEYCHAIN=false
CREATED_PIN=false
COMPLETED=false

cleanup() {
  unset ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD
  if [[ "$COMPLETED" != true ]]; then
    if [[ "$CREATED_KEYCHAIN" == true ]]; then
      security delete-generic-password \
        -a "$KEYCHAIN_ACCOUNT" \
        -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$CREATED_STORE" == true && -f "$SIGNING_STORE" ]]; then
      unlink "$SIGNING_STORE"
    fi
    if [[ "$CREATED_PIN" == true && -f "$PINNED_CERTIFICATE" ]]; then
      unlink "$PINNED_CERTIFICATE"
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -x "$KEYTOOL" ]]; then
  echo "JDK 17 introuvable: $JDK_HOME" >&2
  exit 1
fi
if [[ -s "$PINNED_CERTIFICATE" ]]; then
  echo "L'identité Android officielle est déjà épinglée; restaurer sa sauvegarde au lieu de créer une nouvelle clé" >&2
  exit 1
fi
if [[ -e "$SIGNING_STORE" ]]; then
  echo "Refus d'écraser la clé Android existante: $SIGNING_STORE" >&2
  exit 1
fi
if security find-generic-password \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
  echo "Refus d'écraser l'entrée Trousseau Android existante" >&2
  exit 1
fi

umask 077
mkdir -p "$SIGNING_DIRECTORY"
chmod 0700 "$SIGNING_DIRECTORY"

ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD="$(openssl rand -base64 48 | tr -d '\n')"
export ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD

"$KEYTOOL" -genkeypair -noprompt \
  -alias "$SIGNING_ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -sigalg SHA256withRSA \
  -validity 18263 \
  -dname "CN=RoomFrame TV Production,O=RoomFrame" \
  -storetype PKCS12 \
  -keystore "$SIGNING_STORE" \
  -storepass:env ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD \
  -keypass:env ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD
CREATED_STORE=true
chmod 0600 "$SIGNING_STORE"

printf '%s\n%s\n' \
  "$ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD" \
  "$ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD" |
  security add-generic-password \
    -a "$KEYCHAIN_ACCOUNT" \
    -s "$KEYCHAIN_SERVICE" \
    -l "$KEYCHAIN_SERVICE" \
    -w >/dev/null
CREATED_KEYCHAIN=true

STORED_PASSWORD="$(
  security find-generic-password \
    -a "$KEYCHAIN_ACCOUNT" \
    -s "$KEYCHAIN_SERVICE" \
    -w
)"
if [[ "$STORED_PASSWORD" != "$ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD" ]]; then
  unset STORED_PASSWORD
  echo "Vérification du secret Trousseau échouée" >&2
  exit 1
fi
unset STORED_PASSWORD

CERTIFICATE_SHA256="$(
  "$KEYTOOL" -exportcert \
    -alias "$SIGNING_ALIAS" \
    -keystore "$SIGNING_STORE" \
    -storepass:env ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD |
    openssl dgst -sha256 -r |
    awk '{print $1}'
)"
if [[ ! "$CERTIFICATE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  unset CERTIFICATE_SHA256
  echo "Empreinte publique Android invalide" >&2
  exit 1
fi
printf '%s\n' "$CERTIFICATE_SHA256" > "$PINNED_CERTIFICATE"
CREATED_PIN=true

"$KEYTOOL" -list \
  -keystore "$SIGNING_STORE" \
  -storepass:env ROOMFRAME_NEW_ANDROID_SIGNING_PASSWORD >/dev/null

COMPLETED=true
echo "Clé Android créée hors dépôt: $SIGNING_STORE"
echo "Empreinte publique épinglée: $CERTIFICATE_SHA256"
unset CERTIFICATE_SHA256
echo "Deux sauvegardes indépendantes et un test de restauration restent obligatoires avant le reset."
