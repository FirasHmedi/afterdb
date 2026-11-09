#!/usr/bin/env bash
# CI (macOS runners): selects a released Xcode, never a beta or RC, and exports DEVELOPER_DIR to the next steps.
# Usage: scripts/ci-xcode.sh 26.4     exactly /Applications/Xcode_26.4*.app (26.4 or a 26.4.x patch release)
#        scripts/ci-xcode.sh newest   the newest released Xcode 26.x >= 26.4
set -euo pipefail
XCODE="${1:?usage: scripts/ci-xcode.sh 26.4|newest}"

echo "Installed:"; ls -d /Applications/Xcode*.app || true
case "$XCODE" in
  26.4) pattern='/Applications/Xcode_26.4*.app' ;;
  newest) pattern='/Applications/Xcode_26.*.app' ;;
  *) echo "::error::unknown Xcode choice $XCODE"; exit 1 ;;
esac
best=""; bestkey=0; bestv=""
for app in $pattern; do
  [ -d "$app" ] || continue
  case "$app" in *[Bb]eta*|*Release_Candidate*|*_RC*) continue ;; esac
  v=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null) || continue
  IFS=. read -r a b c <<<"$v"
  key=$(( ${a:-0} * 10000 + ${b:-0} * 100 + ${c:-0} ))
  # 26.4: the version must be 26.4 or 26.4.x (the folder name alone could be misleading)
  if [ "$XCODE" = 26.4 ] && { [ "${a:-}" != 26 ] || [ "${b:-}" != 4 ]; }; then continue; fi
  if [ "$key" -ge 260400 ] && [ "$key" -gt "$bestkey" ]; then bestkey=$key; best=$app; bestv=$v; fi
done
if [ -z "$best" ]; then
  if [ "$XCODE" = 26.4 ]; then
    echo "::error::No released Xcode 26.4 on this runner (looked for $pattern, betas and RCs excluded): the 26.4 entry of the matrix cannot run"
  else
    echo "::error::No released Xcode 26.x >= 26.4 in /Applications (React Native 0.88 and the afterdb patches need it)"
  fi
  exit 1
fi
echo "Using Xcode $bestv ($best)"
sudo xcode-select -s "$best"
echo "DEVELOPER_DIR=$best/Contents/Developer" >> "$GITHUB_ENV"
xcodebuild -version
