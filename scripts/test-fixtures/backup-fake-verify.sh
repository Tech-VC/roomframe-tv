#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 1 && -d "$1" && ! -L "$1" ]]
