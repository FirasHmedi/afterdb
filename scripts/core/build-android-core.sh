#!/usr/bin/env bash
# Builds realm-core (the database engine inside afterdb) from source for one Android ABI.
# Same CMake options as upstream realm-js 20.2.0 (packages/realm/src/scripts/build/android.ts at commit cf86fe01),
# except: no ccache, and OpenSSL comes from the archive shipped in an afterdb package (SHA-256 checked) instead of
# the OpenSSL 3.3.1 download from static.realm.io.
#
# Usage: scripts/core/build-android-core.sh <afterdb package dir> <work dir> [abi]
#   <afterdb package dir>  an unpacked @pomwik/afterdb package (node_modules/@pomwik/afterdb or bridge/out/work/package)
#   <work dir>             where realm-core is cloned and built
#   [abi]                  arm64-v8a (default), armeabi-v7a, x86 or x86_64
# Needs: git, and in the Android SDK: NDK 27.1.12297006 and CMake 3.22.1 (cmake and ninja)
# Output: <work dir>/install-android-<abi>/{include,lib,share}, the layout of prebuilds/android/<abi> in the package
set -euo pipefail

# realm-core v20.1.0: the submodule packages/realm/bindgen/vendor/realm-core of realm-js at cf86fe01
# ("[20.2.0] Bump version"), the commit npm records as gitHead of realm@20.2.0.
CORE_COMMIT=15493076ad9fef22c16cc64cbfbf9e5b65c385f9
CORE_VERSION=20.1.0
NDK_VERSION="${NDK_VERSION:-27.1.12297006}"
CMAKE_VERSION="${CMAKE_VERSION:-3.22.1}"
API=24

PKG="$(cd "$1" && pwd -P)"
mkdir -p "$2"
WORK="$(cd "$2" && pwd -P)"
ABI="${3:-arm64-v8a}"
case "$ABI" in
  arm64-v8a) ARCH=arm64 ;;
  armeabi-v7a) ARCH=arm ;;
  x86) ARCH=x86 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unknown ABI $ABI"; exit 1 ;;
esac

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="$SDK/ndk/$NDK_VERSION"
CMAKE="${CMAKE:-$SDK/cmake/$CMAKE_VERSION/bin/cmake}"
NINJA="${NINJA:-$(dirname "$CMAKE")/ninja}"
for f in "$NDK/build/cmake/android.toolchain.cmake" "$CMAKE" "$NINJA"; do
  [ -e "$f" ] || { echo "Missing $f"; exit 1; }
done

# 1. realm-core at the pinned commit, with the two submodules the library needs (the third one, Catch2, is tests only)
SRC="$WORK/realm-core"
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/realm/realm-core.git
fi
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$CORE_COMMIT" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$CORE_COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
fi
git -C "$SRC" submodule update --init --depth 1 src/external/sha-1 src/external/sha-2
[ "$(git -C "$SRC" rev-parse HEAD)" = "$CORE_COMMIT" ] || { echo "realm-core is not at $CORE_COMMIT"; exit 1; }
grep -q "^VERSION: $CORE_VERSION\$" "$SRC/dependencies.yml" || { echo "dependencies.yml does not say VERSION: $CORE_VERSION"; exit 1; }

# 2. OpenSSL archive from the afterdb package, checked against the SHA-256 the package records for it
DEPS="$PKG/prebuilds/android/$ABI/deps"
ARCHIVE="$(ls "$DEPS"/openssl-*-"$ARCH"-android.tar.gz | head -1)"
NAME="$(basename "$ARCHIVE")"
EXPECTED="$(sed -n "s/^set(AFTERDB_BUNDLED_SHA256_$NAME \"\([0-9a-f]*\)\")\$/\1/p" "$PKG/prebuilds/android/$ABI/share/cmake/Realm/AcquireRealmDependency.cmake")"
ACTUAL="$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
[ -n "$EXPECTED" ] && [ "$ACTUAL" = "$EXPECTED" ] || { echo "$NAME: SHA-256 $ACTUAL, expected '$EXPECTED'"; exit 1; }
echo "OpenSSL: $NAME (SHA-256 $ACTUAL checked)"

# realm-core's CMake skips its OpenSSL download when <build>/openssl/include.cmake exists (tools/cmake/AcquireRealmDependency.cmake)
BUILD="$WORK/build-android-$ABI-Release"
INSTALL="$WORK/install-android-$ABI"
rm -rf "$BUILD" "$INSTALL"
mkdir -p "$BUILD/openssl"
tar -xzf "$ARCHIVE" -C "$BUILD/openssl"
[ -f "$BUILD/openssl/include.cmake" ] || { echo "$NAME has no include.cmake"; exit 1; }

# 3. Configure and build: the flags of upstream's android.ts, in the same order
"$CMAKE" -G Ninja -S "$SRC" -B "$BUILD" \
  --toolchain "$NDK/build/cmake/android.toolchain.cmake" \
  -D CMAKE_SYSTEM_NAME=Android \
  -D "CPACK_SYSTEM_NAME=Android-$ABI" \
  -D "CMAKE_INSTALL_PREFIX=$INSTALL" \
  -D CMAKE_BUILD_TYPE=Release \
  -D "CMAKE_MAKE_PROGRAM=$NINJA" \
  -D CMAKE_CXX_STANDARD=20 \
  -D "ANDROID_NDK=$NDK" \
  -D "ANDROID_ABI=$ABI" \
  -D ANDROID_TOOLCHAIN=clang \
  -D "ANDROID_NATIVE_API_LEVEL=$API" \
  -D ANDROID_STL=c++_shared \
  -D "REALM_VERSION=$CORE_VERSION" \
  -D REALM_BUILD_LIB_ONLY=ON
"$CMAKE" --build "$BUILD" -- install

# 4. Keep what upstream keeps (REALM_CORE_LIBRARY_NAMES_ALLOWLIST in common.ts), drop the docs folder
for f in "$INSTALL"/lib/*; do
  case "$(basename "$f")" in
    librealm.a | librealm-object-store.a | librealm-parser.a) ;;
    *) echo "Deleting $f"; rm -f "$f" ;;
  esac
done
rm -rf "$INSTALL/doc"
ls -l "$INSTALL/lib"
