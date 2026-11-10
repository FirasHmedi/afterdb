#!/usr/bin/env bash
# Builds OpenSSL 3.5 LTS as static libraries for the 4 Android ABIs, packed like the upstream Realm archives
# (include/, lib/, debug/lib/, include.cmake), so that bridge/build.mjs can ship them instead of OpenSSL 3.3.1.
#
# Reproducible: the same OpenSSL source built with the same NDK gives byte-identical archives (the "built on" date of
# libcrypto comes from SOURCE_DATE_EPOCH; tar entries are sorted, dated SOURCE_DATE_EPOCH, owned by 0:0 with fixed
# modes; gzip stores no name or time). The SHA-256 of the 4 archives built with NDK $NDK_VERSION are pinned below:
# a cached archive is reused only if it matches, and a new build must match too.
#
# Usage: bridge/openssl/build-openssl.sh [version]
#   Needs Android NDK $NDK_VERSION: ANDROID_NDK_ROOT, or $ANDROID_HOME/ndk/$NDK_VERSION
#   (sdkmanager --install "ndk;$NDK_VERSION"). With another NDK, set AFTERDB_OPENSSL_ANY_NDK=1: the archives are
#   built, but they will not match the pinned SHA-256 and must not be published.
# Output: bridge/.cache/openssl/openssl-<version>-<arch>-android.tar.gz
set -euo pipefail

VERSION="${1:-3.5.9}"
# The NDK of the pinned archive hashes. The CI and publish workflows read this line and install this NDK.
NDK_VERSION=27.3.13750724
# PINNED: SHA-256 of the source tarball, pinned on 2026-11-06, checked against the value published next to the
# release AND against this one. EPOCH: newest file date in that tarball (2026-09-29 14:05 UTC), used as build date.
case "$VERSION" in
  3.5.9) PINNED=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a; EPOCH=1790690700 ;;
  *) PINNED=""; EPOCH="${SOURCE_DATE_EPOCH:-}"
     [ -n "$EPOCH" ] || { echo "OpenSSL $VERSION is not in the table: set SOURCE_DATE_EPOCH (or add the version)"; exit 1; } ;;
esac
# SHA-256 of each archive built from openssl-$VERSION with NDK $NDK_VERSION (a function: macOS bash 3.2 has no
# associative arrays). Empty for a version or NDK without pinned values.
archive_sha256() {
  case "$VERSION-$1" in
    *) echo "" ;;
  esac
}
UPSTREAM_ARM64_SHA=54e4581c4b123d7f04842a6cec3f153838e8a52c9b162b2a2233efd868247610
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/../.cache/openssl"
WORK="$HERE/../.cache/openssl-build"
API=24
mkdir -p "$CACHE" "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

NDK="${ANDROID_NDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/$NDK_VERSION}"
[ -f "$NDK/source.properties" ] || { echo "Android NDK not found at $NDK: install NDK $NDK_VERSION (sdkmanager --install \"ndk;$NDK_VERSION\") or set ANDROID_NDK_ROOT"; exit 1; }
NDK_REV="$(sed -n 's/^Pkg\.Revision *= *//p' "$NDK/source.properties" | tr -d '\r')"
CHECK=1
if [ "$NDK_REV" != "$NDK_VERSION" ]; then
  if [ "${AFTERDB_OPENSSL_ANY_NDK:-}" != 1 ]; then
    echo "error: NDK $NDK_REV at $NDK, but the pinned archive hashes were built with NDK $NDK_VERSION."
    echo "Install NDK $NDK_VERSION, or set AFTERDB_OPENSSL_ANY_NDK=1 to build anyway (archives not checked, not for release)."
    exit 1
  fi
  echo "warning: NDK $NDK_REV instead of $NDK_VERSION (AFTERDB_OPENSSL_ANY_NDK=1): archives built, not checked against the pinned hashes"
  CHECK=""
fi
echo "Android NDK $NDK_REV ($NDK), OpenSSL $VERSION, SOURCE_DATE_EPOCH=$EPOCH"
export ANDROID_NDK_ROOT="$NDK"
HOST_TAG="$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64"
export PATH="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin:$PATH"
# read by OpenSSL's util/mkbuildinf.pl ("built on: ..." in libcrypto)
export SOURCE_DATE_EPOCH="$EPOCH"
# file dates set before packing ([[CC]YY]MMDDhhmm.SS in UTC; BSD date -r, GNU date -d)
STAMP="$(TZ=UTC date -r "$EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || TZ=UTC date -d "@$EPOCH" +%Y%m%d%H%M.%S)"

# The archives record no local account: every entry is owned by 0:0, without user or group name.
# GNU tar (Linux CI) and bsdtar (macOS) spell this differently.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  TAR_OPTS=(--format=ustar --no-recursion --owner=0 --group=0 --numeric-owner)
else
  TAR_OPTS=(--format=ustar -n --uid 0 --gid 0 --numeric-owner)
  # macOS: no AppleDouble (._*) entries for extended attributes
  [ "$(uname -s)" != Darwin ] || TAR_OPTS+=(--no-mac-metadata)
fi

# Deterministic archive of a folder: modes 755/644, every date set to SOURCE_DATE_EPOCH, entries listed in byte
# order (LC_ALL=C), gzip -n (no file name, no time stamp).
pack() {
  local dir="$1" out="$2"
  find "$dir" -type d -exec chmod 755 {} +
  find "$dir" -type f -exec chmod 644 {} +
  find "$dir" -exec env TZ=UTC touch -t "$STAMP" {} +
  (cd "$dir" && find . -print | LC_ALL=C sort) > "$dir.list"
  COPYFILE_DISABLE=1 tar "${TAR_OPTS[@]}" -C "$dir" -cf - -T "$dir.list" | gzip -n -9 > "$out"
  rm -f "$dir.list"
}

# Source tarball and its published SHA-256 (GitHub release of the OpenSSL project)
SRC="openssl-$VERSION.tar.gz"
BASE="https://github.com/openssl/openssl/releases/download/openssl-$VERSION"
[ -f "$WORK/$SRC" ] || curl -fsSL -o "$WORK/$SRC" "$BASE/$SRC"
curl -fsSL -o "$WORK/$SRC.sha256" "$BASE/$SRC.sha256"
EXPECTED="$(awk '{print $1}' "$WORK/$SRC.sha256")"
ACTUAL="$(sha256 "$WORK/$SRC")"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "SHA-256 mismatch for $SRC"; exit 1; }
[ -z "$PINNED" ] || [ "$PINNED" = "$ACTUAL" ] || { echo "SHA-256 of $SRC differs from the pinned value"; exit 1; }

# The upstream include.cmake only sets paths relative to the archive root: reused as is
INCLUDE_CMAKE="$CACHE/openssl-3.3.1-arm64-android.tar.gz"
[ -f "$INCLUDE_CMAKE" ] || curl -fsSL -o "$INCLUDE_CMAKE" "https://static.realm.io/downloads/dependencies/openssl/3.3.1/openssl-3.3.1-arm64-android.tar.gz"
[ "$(sha256 "$INCLUDE_CMAKE")" = "$UPSTREAM_ARM64_SHA" ] || { echo "SHA-256 mismatch for $INCLUDE_CMAKE"; rm -f "$INCLUDE_CMAKE"; exit 1; }

for pair in arm64-v8a:arm64:android-arm64 armeabi-v7a:arm:android-arm x86:x86:android-x86 x86_64:x64:android-x86_64; do
  IFS=: read -r ABI ARCH TARGET <<<"$pair"
  OUT="$CACHE/openssl-$VERSION-$ARCH-android.tar.gz"
  WANT=""
  [ -z "$CHECK" ] || WANT="$(archive_sha256 "$ARCH")"
  # a cached archive is reused only when it matches its pinned SHA-256
  if [ -f "$OUT" ]; then
    if [ -n "$WANT" ] && [ "$(sha256 "$OUT")" = "$WANT" ]; then echo "cached, SHA-256 matches the pinned value: $OUT"; continue; fi
    echo "cached $OUT: no pinned SHA-256 or a different one, rebuilt"
    rm -f "$OUT"
  fi
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
  # Fail if a local path still leaks into the package (repository folder, home folder or NDK folder)
  for needle in "$REPO" "$HOME" "$NDK"; do
    [ "${#needle}" -gt 1 ] || continue
    if LC_ALL=C grep -rqaF -- "$needle" "$B/pkg"; then
      echo "local path $needle found in:"; LC_ALL=C grep -rlaF -- "$needle" "$B/pkg"; exit 1
    fi
  done
  tar -xzf "$INCLUDE_CMAKE" -C "$B/pkg" include.cmake
  cp "$B/src/LICENSE.txt" "$B/pkg/LICENSE.txt"
  pack "$B/pkg" "$OUT"
  # Owner of every entry, as listed by tar -tv: GNU tar prints "0/0" in column 2, bsdtar "0 0" in columns 3 and 4
  OWNERS="$(tar -tvzf "$OUT" | awk '{ if ($2 ~ /\//) print $2; else print $3 "/" $4 }' | sort -u | tr '\n' ' ')"
  if [ "$OWNERS" != "0/0 " ]; then
    echo "$OUT: entries owned by $OWNERS, expected 0/0 only"; rm -f "$OUT"; exit 1
  fi
  GOT="$(sha256 "$OUT")"
  if [ -n "$WANT" ] && [ "$GOT" != "$WANT" ]; then
    mv "$OUT" "$OUT.mismatch"
    echo "error: $OUT has SHA-256 $GOT, the pinned value for NDK $NDK_VERSION is $WANT (kept as $OUT.mismatch)"
    exit 1
  fi
  [ -n "$WANT" ] && echo "built, SHA-256 matches the pinned value: $OUT" || echo "built (no pinned SHA-256 to compare): $OUT"
done

echo "SHA-256 of the archives (OpenSSL $VERSION, NDK $NDK_REV):"
for ARCH in arm64 arm x86 x64; do
  echo "$(sha256 "$CACHE/openssl-$VERSION-$ARCH-android.tar.gz")  openssl-$VERSION-$ARCH-android.tar.gz"
done
