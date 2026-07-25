#!/usr/bin/env bash
set -Eeuo pipefail

# Génère le script autonome attaché à une GitHub Release.
# Usage:
#   GITHUB_REPOSITORY=owner/roomframe-tv RELEASE_TAG=v0.2.0 \
#   ARCHIVE_PATH=dist/roomframe-tv-v0.2.0.tar.gz ./scripts/build-release-installer.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY est requis (owner/repo)}"
TAG="${RELEASE_TAG:?RELEASE_TAG est requis}"
ARCHIVE_PATH="${ARCHIVE_PATH:?ARCHIVE_PATH est requis}"
DIST="$ROOT/dist"
ARCHIVE_NAME="$(basename "$ARCHIVE_PATH")"
ARCHIVE_URL="https://github.com/${REPOSITORY}/releases/download/${TAG}/${ARCHIVE_NAME}"
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"

mkdir -p "$DIST"
sed \
  -e "s|__ROOMFRAME_ARCHIVE_URL__|${ARCHIVE_URL}|g" \
  -e "s|__ROOMFRAME_ARCHIVE_SHA256__|${ARCHIVE_SHA256}|g" \
  "$ROOT/install.sh" > "$DIST/roomframe-install.sh"
chmod +x "$DIST/roomframe-install.sh"
echo "$DIST/roomframe-install.sh"
