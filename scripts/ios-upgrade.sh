#!/usr/bin/env bash
# In-place upgrade test on a booted iOS simulator (upgrade mode of the example app, example/upgrade/data.ts):
# install A (official realm) and launch, install B (afterdb, same bundle id) over it and launch, then install A
# again and launch. simctl install over an installed app keeps its data container. Each launch must write
# "AFTERDB_UPGRADE_OK stage=<n> history=<writers> items=<n x 120>" to upgrade-result.realm
# (read with scripts/read-upgrade-result.mjs).
# Usage (from a folder whose node_modules/realm can open realm files):
#   scripts/ios-upgrade.sh <A.app> <A writer> <B.app> <B writer> <out dir>
set -euo pipefail
A="$1"; WA="$2"; B="$3"; WB="$4"; OUT="$5"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
bundle() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Info.plist"; }
ID=$(bundle "$A")
[ "$(bundle "$B")" = "$ID" ] || { echo "::error::bundle ids differ: $ID, $(bundle "$B")"; exit 1; }
echo "A: $A ($WA)"
echo "B: $B ($WB)"
echo "both: bundle id $ID"

stage() { # <n> <expected history> <app>
  local n="$1" text="" ok=""
  local want="AFTERDB_UPGRADE_OK stage=$n history=$2 items=$((n * 120))"
  xcrun simctl install booted "$3"
  local data
  data="$(xcrun simctl get_app_container booted "$ID" data)"
  echo "== stage $n: data container $data"
  xcrun simctl launch booted "$ID" >/dev/null
  for _ in $(seq 1 120); do
    if [ -f "$data/Documents/upgrade-result.realm" ]; then
      text="$(node "$HERE/read-upgrade-result.mjs" "$data/Documents/upgrade-result.realm" 2>/dev/null || true)"
      if [ "$text" = "$want" ]; then ok=1; break; fi
      if grep -qE "^AFTERDB_UPGRADE_(FAILED stage=$n |ERROR)" <<<"$text"; then break; fi
    fi
    sleep 1
  done
  xcrun simctl io booted screenshot "$OUT/stage-$n.png" >/dev/null 2>&1 || true
  xcrun simctl terminate booted "$ID" 2>/dev/null || true
  echo "result: $text"
  ls -la "$data/Documents" | sed 's/^/  /'
  [ -n "$ok" ] || { echo "::error::stage $n: expected \"$want\""; exit 1; }
}

xcrun simctl uninstall booted "$ID" 2>/dev/null || true
stage 1 "$WA" "$A"
stage 2 "$WA,$WB" "$B"
stage 3 "$WA,$WB,$WA" "$A"
echo "Upgrade test OK: $WA -> $WB -> $WA, data kept in the app container"
