#!/usr/bin/env bash
# Runs the example app on a booted iOS simulator twice and checks its self-check result, read from
# selfcheck-result.realm in the app's data folder (scripts/read-selfcheck.mjs).
# Usage: scripts/ios-selfcheck.sh <path/to/App.app> <bundle id> <screenshot.png>   (run from the app folder)
set -euo pipefail
APP="$1"; ID="$2"; SHOT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"

xcrun simctl uninstall booted "$ID" 2>/dev/null || true
xcrun simctl install booted "$APP"
for n in 1 2; do
  xcrun simctl launch booted "$ID" >/dev/null
  data="$(xcrun simctl get_app_container booted "$ID" data)"
  file="$data/Documents/selfcheck-result.realm"
  # wait for the result of this launch (the file holds the launch count it was written with)
  ok=""
  for _ in $(seq 1 90); do
    if [ -f "$file" ] && node "$HERE/read-selfcheck.mjs" "$file" "$n" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ "$n" = 2 ] && xcrun simctl io booted screenshot "$SHOT" >/dev/null 2>&1 || true
  xcrun simctl terminate booted "$ID" 2>/dev/null || true
  echo "launch $n: $(node "$HERE/read-selfcheck.mjs" "$file" "$n" 2>&1 || true)"
  [ -n "$ok" ] || { echo "::error::self-check not OK on launch $n"; ls -la "$data/Documents" 2>/dev/null || true; exit 1; }
done
echo "iOS self-check OK on both launches (data kept after a restart)"
