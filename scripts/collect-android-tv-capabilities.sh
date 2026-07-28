#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    "Usage: $0 --target ADB_TARGET --output PRIVATE_DIRECTORY [--include-third-party-packages]" \
    "" \
    "Collecte en lecture seule les capacités utiles d'une Android/Google TV." \
    "Le script ne collecte pas le numéro de série, les comptes, le réseau," \
    "les appareils associés ni le contenu consulté."
}

adb_target=""
output_directory=""
include_third_party=false

while (($#)); do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      adb_target=$2
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      output_directory=$2
      shift 2
      ;;
    --include-third-party-packages)
      include_third_party=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Option inconnue: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$adb_target" && -n "$output_directory" ]] || {
  usage >&2
  exit 2
}

command -v adb >/dev/null 2>&1 || {
  printf '%s\n' "adb est requis." >&2
  exit 1
}

[[ "$(adb -s "$adb_target" get-state 2>/dev/null)" == "device" ]] || {
  printf '%s\n' "La TV n'est pas disponible ou pas autorisée via ADB." >&2
  exit 1
}

mkdir -p "$output_directory/codecs"

capture() {
  local output_name=$1
  shift
  "$@" > "$output_directory/$output_name" 2>&1 || true
}

capture product.txt adb -s "$adb_target" shell \
  'for key in ro.product.manufacturer ro.product.model ro.product.device ro.product.board ro.product.cpu.abilist ro.hardware ro.soc.manufacturer ro.soc.model ro.build.version.release ro.build.version.sdk ro.build.version.security_patch ro.build.fingerprint ro.build.characteristics ro.boot.hardware ro.adb.secure service.adb.tcp.port; do printf "%s=" "$key"; getprop "$key"; done'

capture settings-power-dreams.txt adb -s "$adb_target" shell \
  'for spec in secure:screensaver_enabled secure:screensaver_components secure:screensaver_default_component secure:screensaver_activate_on_dock secure:screensaver_activate_on_sleep secure:sleep_timeout secure:attentive_timeout secure:doze_always_on secure:user_setup_complete system:screen_off_timeout global:stay_on_while_plugged_in global:low_power global:theater_mode_on global:device_provisioned global:development_settings_enabled global:adb_enabled global:hdmi_control_enabled global:hdmi_control_auto_device_off_enabled global:hdmi_control_auto_tv_off_enabled global:hdmi_system_audio_enabled; do namespace=${spec%%:*}; key=${spec#*:}; printf "%s.%s=" "$namespace" "$key"; settings get "$namespace" "$key"; done'

capture features.txt adb -s "$adb_target" shell pm list features
capture memory.txt adb -s "$adb_target" shell cat /proc/meminfo
capture storage.txt adb -s "$adb_target" shell df -h
capture display-size-density.txt adb -s "$adb_target" shell \
  'wm size; wm density'
capture display.txt adb -s "$adb_target" shell dumpsys display
capture window.txt adb -s "$adb_target" shell dumpsys window
capture input.txt adb -s "$adb_target" shell dumpsys input
capture tv-input.txt adb -s "$adb_target" shell dumpsys tv_input
capture hdmi-control.txt adb -s "$adb_target" shell dumpsys hdmi_control
capture audio.txt adb -s "$adb_target" shell dumpsys audio
capture power.txt adb -s "$adb_target" shell dumpsys power
capture dreams.txt adb -s "$adb_target" shell dumpsys dreams
capture device-idle.txt adb -s "$adb_target" shell dumpsys deviceidle
capture alarms.txt adb -s "$adb_target" shell dumpsys alarm
capture jobscheduler.txt adb -s "$adb_target" shell dumpsys jobscheduler
capture device-policy.txt adb -s "$adb_target" shell dumpsys device_policy
capture users.txt adb -s "$adb_target" shell pm list users
capture roles-home.txt adb -s "$adb_target" shell cmd role get-role-holders android.app.role.HOME
capture home-resolution.txt adb -s "$adb_target" shell cmd package resolve-activity \
  --brief -a android.intent.action.MAIN -c android.intent.category.HOME
capture leanback-activities.txt adb -s "$adb_target" shell cmd package query-activities \
  --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER
capture packages-system.txt adb -s "$adb_target" shell pm list packages -s
capture packages-relevant.txt adb -s "$adb_target" shell \
  'pm list packages | grep -Ei "philips|sony|bravia|tpv|mediatek|airplay|cast|chromecast|hdmi|power|packageinstaller|canal|netflix|roomframe" | sort'
capture services.txt adb -s "$adb_target" shell service list
capture roomframe-package.txt adb -s "$adb_target" shell dumpsys package org.roomframe.tv
capture codec-service.txt adb -s "$adb_target" shell dumpsys media.codec
capture codec-files.txt adb -s "$adb_target" shell \
  'ls -1 /vendor/etc/media_codecs*.xml 2>/dev/null'

if [[ "$include_third_party" == true ]]; then
  capture packages-third-party.txt adb -s "$adb_target" shell pm list packages -3
fi

while IFS= read -r codec_file; do
  codec_file=${codec_file%$'\r'}
  case "$codec_file" in
    /vendor/etc/media_codecs*.xml)
      adb -s "$adb_target" pull "$codec_file" "$output_directory/codecs/" \
        >/dev/null 2>&1 || true
      ;;
  esac
done < "$output_directory/codec-files.txt"

(
  cd "$output_directory"
  if command -v shasum >/dev/null 2>&1; then
    find . -type f ! -name MANIFEST_SHA256.txt -print0 \
      | sort -z \
      | xargs -0 shasum -a 256
  else
    find . -type f ! -name MANIFEST_SHA256.txt -print0 \
      | sort -z \
      | xargs -0 sha256sum
  fi
) > "$output_directory/MANIFEST_SHA256.txt"

printf 'Collecte terminée dans %s (%s fichiers).\n' \
  "$output_directory" \
  "$(find "$output_directory" -type f | wc -l | tr -d ' ')"
