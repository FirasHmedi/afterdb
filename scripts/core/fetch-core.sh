#!/usr/bin/env bash
# Clones realm-core at the commit inside realm@20.2.0 (and @pomwik/afterdb 20.3.0) into <work dir>/realm-core,
# with the two submodules the library needs (the third one, Catch2, is only for tests). Prints the source folder.
#
# realm-core v20.1.0 (15493076) is the submodule packages/realm/bindgen/vendor/realm-core of realm-js at cf86fe01
# ("[20.2.0] Bump version"), the commit npm records as gitHead of realm@20.2.0. Do not use the git tag v20.2.0 of
# realm-js: it points to 5064bb5, a 12.15.0 commit whose submodule is realm-core 14.14.0.
#
# Usage: scripts/core/fetch-core.sh <work dir>
set -euo pipefail
CORE_COMMIT=15493076ad9fef22c16cc64cbfbf9e5b65c385f9
CORE_VERSION=20.1.0

mkdir -p "$1"
SRC="$(cd "$1" && pwd -P)/realm-core"
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/realm/realm-core.git
fi
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$CORE_COMMIT" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$CORE_COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
fi
git -C "$SRC" submodule update --init --depth 1 src/external/sha-1 src/external/sha-2 >&2
[ "$(git -C "$SRC" rev-parse HEAD)" = "$CORE_COMMIT" ] || { echo "realm-core is not at $CORE_COMMIT" >&2; exit 1; }
grep -q "^VERSION: $CORE_VERSION\$" "$SRC/dependencies.yml" || { echo "dependencies.yml does not say VERSION: $CORE_VERSION" >&2; exit 1; }
echo "$SRC"
