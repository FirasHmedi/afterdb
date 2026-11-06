#!/usr/bin/env bash
# Builds OpenSSL 3.5 LTS as static libraries for the 4 Android ABIs, packed like the upstream Realm archives
# (include/, lib/, debug/lib/, include.cmake), so that bridge/build.mjs can ship them instead of OpenSSL 3.3.1.
#
# Usage: bridge/openssl/build-openssl.sh [version]   (needs the Android NDK: ANDROID_NDK_ROOT or $ANDROID_HOME/ndk/<x>)
# Output: bridge/.cache/openssl/openssl-<version>-<arch>-android.tar.gz
set -euo pipefail

VERSION="${1:-3.5.9}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/../.cache/openssl"
WORK="$HERE/../.cache/openssl-build"
API=24
mkdir -p "$CACHE" "$WORK"

NDK="${ANDROID_NDK_ROOT:-}"
if [ -z "$NDK" ]; then
  NDK="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/ndk/27.* 2>/dev/null | sort -V | tail -1)"
fi
[ -d "$NDK" ] || { echo "Android NDK not found (set ANDROID_NDK_ROOT)"; exit 1; }
export ANDROID_NDK_ROOT="$NDK"
HOST_TAG="$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64"
export PATH="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin:$PATH"

# Source tarball and its published SHA-256 (GitHub release of the OpenSSL project)
SRC="openssl-$VERSION.tar.gz"
BASE="https://github.com/openssl/openssl/releases/download/openssl-$VERSION"
[ -f "$WORK/$SRC" ] || curl -fsSL -o "$WORK/$SRC" "$BASE/$SRC"
curl -fsSL -o "$WORK/$SRC.sha256" "$BASE/$SRC.sha256"
EXPECTED="$(awk '{print $1}' "$WORK/$SRC.sha256")"
ACTUAL="$(shasum -a 256 "$WORK/$SRC" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "SHA-256 mismatch for $SRC"; exit 1; }

# The upstream include.cmake only sets paths relative to the archive root: reused as is
INCLUDE_CMAKE="$CACHE/openssl-3.3.1-arm64-android.tar.gz"
[ -f "$INCLUDE_CMAKE" ] || curl -fsSL -o "$INCLUDE_CMAKE" "https://static.realm.io/downloads/dependencies/openssl/3.3.1/openssl-3.3.1-arm64-android.tar.gz"

for pair in arm64-v8a:arm64:android-arm64 armeabi-v7a:arm:android-arm x86:x86:android-x86 x86_64:x64:android-x86_64; do
  IFS=: read -r ABI ARCH TARGET <<<"$pair"
  OUT="$CACHE/openssl-$VERSION-$ARCH-android.tar.gz"
  if [ -f "$OUT" ]; then echo "exists: $OUT"; continue; fi
  echo "== $ABI ($TARGET)"
  B="$WORK/$ABI"
  rm -rf "$B" && mkdir -p "$B/src" "$B/pkg"
  tar -xzf "$WORK/$SRC" -C "$B/src" --strip-components=1
  (
    cd "$B/src"
    ./Configure "$TARGET" -D__ANDROID_API__=$API no-shared no-tests no-docs no-apps no-engine no-module \
      --prefix="$B/prefix" --openssldir="$B/prefix/etc/ssl" >/dev/null
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" build_libs >/dev/null
    make install_dev >/dev/null
  )
  mkdir -p "$B/pkg/lib" "$B/pkg/debug/lib" "$B/pkg/include"
  cp -R "$B/prefix/include/openssl" "$B/pkg/include/"
  cp "$B/prefix/lib/libcrypto.a" "$B/prefix/lib/libssl.a" "$B/pkg/lib/" 2>/dev/null || cp "$B"/prefix/lib*/lib{crypto,ssl}.a "$B/pkg/lib/"
  cp "$B/pkg/lib/"*.a "$B/pkg/debug/lib/"
  tar -xzf "$INCLUDE_CMAKE" -C "$B/pkg" include.cmake
  cp "$B/src/LICENSE.txt" "$B/pkg/LICENSE.txt"
  tar -czf "$OUT" -C "$B/pkg" .
  echo "built: $OUT"
done
