#!/usr/bin/env bash
set -Eeuo pipefail

case "${1:-}" in
  ps)
    exit 0
    ;;
  exec)
    printf '%s' "ROOMFRAME-FAKE-POSTGRES-CUSTOM-DUMP"
    ;;
  pause|unpause)
    exit 0
    ;;
  *)
    printf 'Commande Compose de test inattendue: %s\n' "${1:-absente}" >&2
    exit 1
    ;;
esac
