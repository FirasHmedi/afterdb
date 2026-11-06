#!/usr/bin/env bash
# Builds OpenSSL 3.5 LTS as static libraries for the 4 Android ABIs, packed like the upstream Realm archives
# (include/, lib/, debug/lib/, include.cmake), so that bridge/build.mjs can ship them instead of OpenSSL 3.3.1.
#
# Usage: bridge/openssl/build-openssl.sh [version]   (needs the Android NDK: ANDROID_NDK_ROOT or $ANDROID_HOME/ndk/<x>)
# Output: bridge/.cache/openssl/openssl-<version>-<arch>-android.tar.gz
set -euo pipefail

VERSION="${1:-3.5.9}"
# SHA-256 pinned on 2026-11-06, checked against the value published next to the release AND against this one
case "$VERSION" in
  3.5.9) PINNED=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a ;;
  *) PINNED="" ;;
esac
UPSTREAM_ARM64_SHA=54e4581c4b123d7f04842a6cec3f153838e8a52c9b162b2a2233efd868247610
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/../.cache/openssl"
WORK="$HERE/../.cache/openssl-build"
API=24
mkdir -p "$CACHE" "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"

NDK="${ANDROID_NDK_ROOT:-}"
if [ -z "$NDK" ]; then
  NDK="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/ndk/27.* 2>/dev/null | sort -V | tail -1)"
fi
[ -d "$NDK" ] || { echo "Android NDK not found (set ANDROID_NDK_ROOT)"; exit 1; }
export ANDROID_NDK_ROOT="$NDK"
HOST_TAG="$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64"
export PATH="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin:$PATH"

# The archives record no local account: every entry is owned by 0:0, without user or group name.
# GNU tar (Linux CI) and bsdtar (macOS) spell this differently.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  TAR_OWNER=(--owner=0 --group=0 --numeric-owner)
else
  TAR_OWNER=(--uid 0 --gid 0 --numeric-owner)
fi

# Source tarball and its published SHA-256 (GitHub release of the OpenSSL project)
SRC="openssl-$VERSION.tar.gz"
BASE="https://github.com/openssl/openssl/releases/download/openssl-$VERSION"
[ -f "$WORK/$SRC" ] || curl -fsSL -o "$WORK/$SRC" "$BASE/$SRC"
curl -fsSL -o "$WORK/$SRC.sha256" "$BASE/$SRC.sha256"
EXPECTED="$(awk '{print $1}' "$WORK/$SRC.sha256")"
ACTUAL="$(shasum -a 256 "$WORK/$SRC" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "SHA-256 mismatch for $SRC"; exit 1; }
[ -z "$PINNED" ] || [ "$PINNED" = "$ACTUAL" ] || { echo "SHA-256 of $SRC differs from the pinned value"; exit 1; }

# The upstream include.cmake only sets paths relative to the archive root: reused as is
INCLUDE_CMAKE="$CACHE/openssl-3.3.1-arm64-android.tar.gz"
[ -f "$INCLUDE_CMAKE" ] || curl -fsSL -o "$INCLUDE_CMAKE" "https://static.realm.io/downloads/dependencies/openssl/3.3.1/openssl-3.3.1-arm64-android.tar.gz"
[ "$(shasum -a 256 "$INCLUDE_CMAKE" | awk '{print $1}')" = "$UPSTREAM_ARM64_SHA" ] || { echo "SHA-256 mismatch for $INCLUDE_CMAKE"; rm -f "$INCLUDE_CMAKE"; exit 1; }

for pair in arm64-v8a:arm64:android-arm64 armeabi-v7a:arm:android-arm x86:x86:android-x86 x86_64:x64:android-x86_64; do
  IFS=: read -r ABI ARCH TARGET <<<"$pair"
  OUT="$CACHE/openssl-$VERSION-$ARCH-android.tar.gz"
  if [ -f "$OUT" ]; then echo "exists: $OUT"; continue; fi
  echo "== $ABI ($TARGET)"
  B="$WORK/$ABI"
  rm -rf "$B" && mkdir -p "$B/src" "$B/pkg"
  tar -xzf "$WORK/$SRC" -C "$B/src" --strip-components=1
  # No build path may end up in the libraries:
  # - --prefix and --openssldir are compiled into libcrypto (ENGINESDIR, MODULESDIR, OPENSSLDIR), so both are
  #   neutral and the files are staged with DESTDIR instead of being installed into the prefix.
  # - Sources are compiled in-tree with relative paths, so __FILE__ holds no absolute path. No -ffile-prefix-map:
  #   the compiler flags are embedded verbatim in libcrypto (OpenSSL_version(OPENSSL_CFLAGS)), the flag itself
  #   would add the build path back.
  STAGE="$B/stage"
  (
    cd "$B/src"
    ./Configure "$TARGET" -D__ANDROID_API__=$API no-shared no-tests no-docs no-apps no-engine no-module \
      --prefix=/usr/local --openssldir=/etc/ssl >/dev/null
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" build_libs >/dev/null
    make install_dev DESTDIR="$STAGE" >/dev/null
  )
  P="$STAGE/usr/local"
  mkdir -p "$B/pkg/lib" "$B/pkg/debug/lib" "$B/pkg/include"
  cp -R "$P/include/openssl" "$B/pkg/include/"
  cp "$P/lib/libcrypto.a" "$P/lib/libssl.a" "$B/pkg/lib/" 2>/dev/null || cp "$P"/lib*/lib{crypto,ssl}.a "$B/pkg/lib/"
  cp "$B/pkg/lib/"*.a "$B/pkg/debug/lib/"
  # Fail if a local path still leaks into the package (repository folder or home folder)
  for needle in "$REPO" "$HOME"; do
    [ "${#needle}" -gt 1 ] || continue
    if LC_ALL=C grep -rqaF -- "$needle" "$B/pkg"; then
      echo "local path $needle found in:"; LC_ALL=C grep -rlaF -- "$needle" "$B/pkg"; exit 1
    fi
  done
  tar -xzf "$INCLUDE_CMAKE" -C "$B/pkg" include.cmake
  cp "$B/src/LICENSE.txt" "$B/pkg/LICENSE.txt"
  tar "${TAR_OWNER[@]}" -czf "$OUT" -C "$B/pkg" .
  # Owner of every entry, as listed by tar -tv: GNU tar prints "0/0" in column 2, bsdtar "0 0" in columns 3 and 4
  OWNERS="$(tar -tvzf "$OUT" | awk '{ if ($2 ~ /\//) print $2; else print $3 "/" $4 }' | sort -u | tr '\n' ' ')"
  if [ "$OWNERS" != "0/0 " ]; then
    echo "$OUT: entries owned by $OWNERS, expected 0/0 only"; rm -f "$OUT"; exit 1
  fi
  echo "built: $OUT"
done
