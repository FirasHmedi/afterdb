#!/usr/bin/env bash
# Compares realm-core built by build-android-core.sh with the prebuilt engine shipped in an afterdb package:
# file sizes, archive members, defined and undefined global symbols of each library, headers and CMake files.
# Prints the differences, then exits 1 if archive members, global symbols or headers differ. Sizes and CMake files are
# expected to differ (build paths, CMake version) and do not change the exit code.
#
# Usage: scripts/core/compare-android-core.sh <afterdb package dir> <install dir> [abi]
set -euo pipefail
export LC_ALL=C
PKG="$(cd "$1" && pwd -P)"
NEW="$(cd "$2" && pwd -P)"
ABI="${3:-arm64-v8a}"
OLD="$PKG/prebuilds/android/$ABI"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="$SDK/ndk/${NDK_VERSION:-27.1.12297006}"
BIN="$(ls -d "$NDK"/toolchains/llvm/prebuilt/*/bin | head -1)"
NM="$BIN/llvm-nm"
AR="$BIN/llvm-ar"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DIFFS=0

# global symbol names of an archive (llvm-nm prints "member.o:" headers and blank lines between members)
syms() { "$NM" "$@" --extern-only --format=just-symbols 2>/dev/null | { grep -v -e ':$' -e '^$' || true; } | sort -u; }

echo "== $ABI: prebuilt = $OLD"
echo "== $ABI: from source = $NEW"
for lib in librealm.a librealm-object-store.a librealm-parser.a; do
  o="$OLD/lib/$lib"; n="$NEW/lib/$lib"
  echo
  echo "== $lib"
  echo "size: prebuilt $(wc -c <"$o" | tr -d ' ') bytes, from source $(wc -c <"$n" | tr -d ' ') bytes"
  "$AR" t "$o" | sort >"$TMP/mo"; "$AR" t "$n" | sort >"$TMP/mn"
  echo "members: prebuilt $(wc -l <"$TMP/mo" | tr -d ' '), from source $(wc -l <"$TMP/mn" | tr -d ' '), only prebuilt $(comm -23 "$TMP/mo" "$TMP/mn" | wc -l | tr -d ' '), only from source $(comm -13 "$TMP/mo" "$TMP/mn" | wc -l | tr -d ' ')"
  cmp -s "$TMP/mo" "$TMP/mn" || DIFFS=$((DIFFS + 1))
  for kind in defined undefined; do
    syms --$kind-only "$o" >"$TMP/so"; syms --$kind-only "$n" >"$TMP/sn"
    if [ "$kind" = undefined ]; then
      # a symbol defined by another member of the same archive is not an external reference
      syms --defined-only "$o" | comm -23 "$TMP/so" - >"$TMP/x"; mv "$TMP/x" "$TMP/so"
      syms --defined-only "$n" | comm -23 "$TMP/sn" - >"$TMP/x"; mv "$TMP/x" "$TMP/sn"
    fi
    comm -23 "$TMP/so" "$TMP/sn" >"$TMP/onlyo"; comm -13 "$TMP/so" "$TMP/sn" >"$TMP/onlyn"
    echo "$kind global symbols: prebuilt $(wc -l <"$TMP/so" | tr -d ' '), from source $(wc -l <"$TMP/sn" | tr -d ' '), only prebuilt $(wc -l <"$TMP/onlyo" | tr -d ' '), only from source $(wc -l <"$TMP/onlyn" | tr -d ' ')"
    if [ -s "$TMP/onlyo" ]; then echo "  first 15 only in prebuilt:"; head -15 "$TMP/onlyo" | sed 's/^/    /'; fi
    if [ -s "$TMP/onlyn" ]; then echo "  first 15 only from source:"; head -15 "$TMP/onlyn" | sed 's/^/    /'; fi
    if [ -s "$TMP/onlyo" ] || [ -s "$TMP/onlyn" ]; then DIFFS=$((DIFFS + 1)); fi
  done
done

echo
echo "== OpenSSL symbols referenced by librealm.a (undefined, EVP_/AES_/SHA/HMAC/RAND_/ERR_/OPENSSL_)"
for side in prebuilt:"$OLD" from-source:"$NEW"; do
  syms --undefined-only "${side#*:}/lib/librealm.a" | { grep -E '^(EVP_|AES_|SHA|HMAC|RAND_|ERR_|OPENSSL_)' || true; } | tr '\n' ' ' | sed "s/^/${side%%:*}: /"
  echo
done

echo
echo "== headers (include/): files that differ or exist on one side only"
diff -rq "$OLD/include" "$NEW/include" || DIFFS=$((DIFFS + 1))
echo "== header files: prebuilt $(find "$OLD/include" -type f | wc -l | tr -d ' '), from source $(find "$NEW/include" -type f | wc -l | tr -d ' ')"
for f in realm/util/config.h realm/version_numbers.hpp; do
  if ! cmp -s "$OLD/include/$f" "$NEW/include/$f"; then echo "--- diff $f"; diff "$OLD/include/$f" "$NEW/include/$f" || true; fi
done

echo
echo "== share/cmake/Realm: RealmTargets*.cmake (afterdb patches AcquireRealmDependency.cmake and RealmConfig.cmake)"
for f in RealmTargets.cmake RealmTargets-release.cmake RealmConfig.cmake; do
  if cmp -s "$OLD/share/cmake/Realm/$f" "$NEW/share/cmake/Realm/$f"; then echo "$f: identical"; else echo "--- diff $f"; diff "$OLD/share/cmake/Realm/$f" "$NEW/share/cmake/Realm/$f" || true; fi
done

echo
if [ "$DIFFS" -gt 0 ]; then
  echo "error: $DIFFS difference(s) in archive members, global symbols or headers (see above)"
  exit 1
fi
echo "archive members, global symbols and headers: no difference"
