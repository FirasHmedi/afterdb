#!/usr/bin/env bash
# Compares librealm-combined.a built by build-ios-sim-core.sh with the same architecture of the iOS simulator slice of
# the prebuilt realm-core.xcframework in an afterdb package: size, archive members, defined and undefined global symbols.
# Prints the differences; exits 0 whatever they are (the output is the result).
#
# Usage: scripts/core/compare-ios-sim-core.sh <afterdb package dir> <librealm-combined.a built here> [arch]
set -euo pipefail
export LC_ALL=C
PKG="$(cd "$1" && pwd -P)"
NEW="$2"
ARCH="${3:-arm64}"
FAT="$PKG/prebuilds/apple/realm-core.xcframework/ios-arm64_x86_64-simulator/librealm-combined.a"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OLD="$TMP/prebuilt-$ARCH.a"
lipo -thin "$ARCH" "$FAT" -output "$OLD"

syms() { xcrun nm "$@" --extern-only --format=just-symbols 2>/dev/null | { grep -v -e ':$' -e '^$' || true; } | sort -u; }

echo "== iphonesimulator $ARCH: prebuilt = $FAT ($ARCH slice)"
echo "== iphonesimulator $ARCH: from source = $NEW"
echo "size: prebuilt $(wc -c <"$OLD" | tr -d ' ') bytes, from source $(wc -c <"$NEW" | tr -d ' ') bytes"
ar t "$OLD" | sort >"$TMP/mo"; ar t "$NEW" | sort >"$TMP/mn"
echo "members: prebuilt $(wc -l <"$TMP/mo" | tr -d ' '), from source $(wc -l <"$TMP/mn" | tr -d ' '), only prebuilt $(comm -23 "$TMP/mo" "$TMP/mn" | wc -l | tr -d ' '), only from source $(comm -13 "$TMP/mo" "$TMP/mn" | wc -l | tr -d ' ')"
for kind in defined undefined; do
  syms --$kind-only "$OLD" >"$TMP/so"; syms --$kind-only "$NEW" >"$TMP/sn"
  if [ "$kind" = undefined ]; then
    syms --defined-only "$OLD" | comm -23 "$TMP/so" - >"$TMP/x" && mv "$TMP/x" "$TMP/so"
    syms --defined-only "$NEW" | comm -23 "$TMP/sn" - >"$TMP/x" && mv "$TMP/x" "$TMP/sn"
  fi
  comm -23 "$TMP/so" "$TMP/sn" >"$TMP/onlyo"; comm -13 "$TMP/so" "$TMP/sn" >"$TMP/onlyn"
  echo "$kind global symbols: prebuilt $(wc -l <"$TMP/so" | tr -d ' '), from source $(wc -l <"$TMP/sn" | tr -d ' '), only prebuilt $(wc -l <"$TMP/onlyo" | tr -d ' '), only from source $(wc -l <"$TMP/onlyn" | tr -d ' ')"
  if [ -s "$TMP/onlyo" ]; then echo "  first 15 only in prebuilt:"; head -15 "$TMP/onlyo" | sed 's/^/    /'; fi
  if [ -s "$TMP/onlyn" ]; then echo "  first 15 only from source:"; head -15 "$TMP/onlyn" | sed 's/^/    /'; fi
done
echo "minimum iOS version and SDK of the first member (prebuilt, then from source):"
for f in "$OLD" "$NEW"; do
  m="$(ar t "$f" | grep '\.o$' | head -1)"
  (cd "$TMP" && ar x "$f" "$m" && xcrun vtool -show-build "$m" 2>/dev/null | grep -E 'platform|minos|sdk' | tr -s ' ' | tr '\n' ' '; echo; rm -f "$m")
done
