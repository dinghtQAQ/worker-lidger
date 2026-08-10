#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_plist="$project_root/shortcuts/worker-lidger.shortcut.plist"
signed_shortcut="$project_root/shortcuts/worker-lidger.shortcut"
unsigned_shortcut=$(mktemp "${TMPDIR:-/tmp}/worker-lidger.XXXXXX.shortcut")

cleanup() {
  rm -f -- "$unsigned_shortcut"
}
trap cleanup EXIT HUP INT TERM

node "$project_root/scripts/generate-shortcut.mjs" --output "$source_plist"
plutil -lint "$source_plist"
plutil -convert binary1 -o "$unsigned_shortcut" "$source_plist"
shortcuts sign --mode anyone --input "$unsigned_shortcut" --output "$signed_shortcut"
chmod 0644 "$signed_shortcut"

printf 'Signed shortcut: %s\n' "$signed_shortcut"
shasum -a 256 "$signed_shortcut"
