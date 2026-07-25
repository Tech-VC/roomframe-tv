#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
TOKEN_FILE="$CONFIG_DIR/secrets/bootstrap_token"
ROTATE=0
SHOW=0

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-bootstrap-token
  sudo roomframe-bootstrap-token --show
  sudo roomframe-bootstrap-token --rotate [--show]

Sans option, vérifie uniquement la présence du jeton. --rotate est une action
explicite; une réinstallation de RoomFrame ne régénère jamais ce secret.
USAGE
}

while (($#)); do
  case "$1" in
    --rotate) ROTATE=1; shift ;;
    --show) SHOW=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "Exécutez cette commande avec sudo/root." >&2
  exit 1
}
[[ ! -L "$TOKEN_FILE" ]] || {
  echo "Le fichier de jeton ne peut pas être un lien symbolique." >&2
  exit 1
}

if [[ "$ROTATE" -eq 1 ]]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  temporary="$(mktemp "$(dirname "$TOKEN_FILE")/.bootstrap-token.XXXXXX")"
  openssl rand -hex 32 >"$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f "$temporary" "$TOKEN_FILE"
  printf '%s\n' "Jeton de bootstrap remplacé explicitement."

  runtime_config="$CONFIG_DIR/runtime.conf"
  if [[ -r "$runtime_config" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$runtime_config"
    set +a
    compose_command="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}/scripts/roomframe-compose.sh"
    if [[ -x "$compose_command" ]] \
      && [[ -n "$("$compose_command" ps -q api 2>/dev/null || true)" ]]; then
      "$compose_command" up -d --no-deps --force-recreate api >/dev/null
      printf '%s\n' "Service API recréé pour monter le nouveau secret."
    fi
  fi
fi

[[ -f "$TOKEN_FILE" && -s "$TOKEN_FILE" ]] || {
  echo "Jeton de bootstrap absent ou vide. Relancez install.sh ou utilisez --rotate." >&2
  exit 1
}

if [[ "$SHOW" -eq 1 ]]; then
  printf '%s\n' "Jeton de bootstrap initial (ne le copiez que dans l'assistant local):"
  IFS= read -r token <"$TOKEN_FILE"
  printf '%s\n' "$token"
  unset token
else
  printf '%s\n' "Jeton de bootstrap présent. Utilisez --show pour un affichage local explicite."
fi
