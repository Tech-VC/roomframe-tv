#!/usr/bin/env bash
set -Eeuo pipefail
set +x

# Construit et vérifie l'APK Android signée sans écrire le secret dans le dépôt.
# Le conteneur PKCS#12 reste hors dépôt et son mot de passe vient du Trousseau.

ROOMFRAME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_PROJECT="$ROOMFRAME_ROOT/apps/tv-android"
SIGNING_ALIAS="roomframe-tv-production-v1"
KEYCHAIN_SERVICE="RoomFrame Android Signing Store Password"
KEYCHAIN_ACCOUNT="$SIGNING_ALIAS"
SIGNING_STORE="${ROOMFRAME_ANDROID_SIGNING_STORE:-$HOME/Library/Application Support/RoomFrame/signing/$SIGNING_ALIAS.p12}"
JDK_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
APKSIGNER="$ANDROID_SDK/build-tools/35.0.0/apksigner"
APK="$ANDROID_PROJECT/app/build/outputs/apk/release/app-release.apk"
PINNED_CERTIFICATE="$ANDROID_PROJECT/signing-certificate-sha256.txt"

if [[ ! -f "$SIGNING_STORE" ]]; then
  echo "Clé Android absente: $SIGNING_STORE" >&2
  exit 1
fi
if [[ ! -x "$JDK_HOME/bin/java" ]]; then
  echo "JDK 17 introuvable: $JDK_HOME" >&2
  exit 1
fi
if [[ ! -x "$APKSIGNER" ]]; then
  echo "apksigner 35.0.0 introuvable: $APKSIGNER" >&2
  exit 1
fi
if [[ ! -f "$PINNED_CERTIFICATE" ]]; then
  echo "Empreinte publique Android absente: $PINNED_CERTIFICATE" >&2
  exit 1
fi

SIGNING_PASSWORD="$(
  security find-generic-password \
    -a "$KEYCHAIN_ACCOUNT" \
    -s "$KEYCHAIN_SERVICE" \
    -w
)"
if [[ -z "$SIGNING_PASSWORD" ]]; then
  echo "Mot de passe de signature Android absent du Trousseau" >&2
  exit 1
fi

cleanup() {
  unset SIGNING_PASSWORD
  unset ROOMFRAME_ANDROID_SIGNING_STORE_PASSWORD
  unset ROOMFRAME_ANDROID_SIGNING_KEY_PASSWORD
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export JAVA_HOME="$JDK_HOME"
export ANDROID_HOME="$ANDROID_SDK"
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export ROOMFRAME_ANDROID_SIGNING_STORE="$SIGNING_STORE"
export ROOMFRAME_ANDROID_SIGNING_STORE_PASSWORD="$SIGNING_PASSWORD"
export ROOMFRAME_ANDROID_SIGNING_KEY_ALIAS="$SIGNING_ALIAS"
export ROOMFRAME_ANDROID_SIGNING_KEY_PASSWORD="$SIGNING_PASSWORD"

(
  cd "$ANDROID_PROJECT"
  ./gradlew --no-daemon --no-configuration-cache \
    clean \
    :app:testDebugUnitTest \
    :app:assembleRelease
)

if [[ ! -f "$APK" ]]; then
  echo "APK release signée introuvable: $APK" >&2
  exit 1
fi

VERIFY_OUTPUT="$("$APKSIGNER" verify --verbose --print-certs "$APK")"
printf '%s\n' "$VERIFY_OUTPUT"
if ! grep -Fq 'Verified using v3 scheme (APK Signature Scheme v3): true' <<<"$VERIFY_OUTPUT"; then
  echo "L'APK release n'utilise pas le schéma de signature v3 attendu" >&2
  exit 1
fi
EXPECTED_CERTIFICATE="$(tr -d '[:space:]' < "$PINNED_CERTIFICATE")"
ACTUAL_CERTIFICATE="$(
  sed -n 's/^Signer #1 certificate SHA-256 digest: //p' <<<"$VERIFY_OUTPUT"
)"
if [[ "$ACTUAL_CERTIFICATE" != "$EXPECTED_CERTIFICATE" ]]; then
  echo "Empreinte du certificat Android inattendue" >&2
  exit 1
fi
unset VERIFY_OUTPUT EXPECTED_CERTIFICATE ACTUAL_CERTIFICATE
shasum -a 256 "$APK"
