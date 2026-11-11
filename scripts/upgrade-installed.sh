#!/usr/bin/env bash
# Checks which packages an app installed as "realm" and "@realm/react", and where they come from (details on
# stderr), then prints name@version of the "realm" package: the label that the upgrade mode writes into the files.
#   realm-20.2.0    the official realm@20.2.0 and @realm/react@0.20.0 from registry.npmjs.org, with the registry's integrity
#   afterdb-npm     @pomwik/afterdb@20.3.0 and @pomwik/afterdb-react@0.20.1 from registry.npmjs.org, same
#   afterdb-commit  the tarballs built from this commit (bridge/out, react/out)
# Usage (from the app folder, after npm install): scripts/upgrade-installed.sh <source>
set -euo pipefail
SRC="$1"
info() { node -p "const p = require('./node_modules/$1/package.json'); p.name + '@' + p.version"; }
lock() { node -p "const l = require('./package-lock.json').packages['node_modules/$1'] || {}; (l.resolved || '-') + ' ' + (l.integrity || '-')"; }
case "$SRC" in
  realm-20.2.0) want="realm@20.2.0 @realm/react@0.20.0"; registry=1 ;;
  afterdb-npm) want="@pomwik/afterdb@20.3.0 @pomwik/afterdb-react@0.20.1"; registry=1 ;;
  afterdb-commit) want="@pomwik/afterdb@20.3.0 @pomwik/afterdb-react@0.20.1"; registry="" ;;
  *) echo "::error::unknown source $SRC" >&2; exit 1 ;;
esac
read -r want_realm want_react <<<"$want"
got_realm=$(info realm); got_react=$(info @realm/react)
[ "$got_realm" = "$want_realm" ] || { echo "::error::realm is $got_realm, expected $want_realm" >&2; exit 1; }
[ "$got_react" = "$want_react" ] || { echo "::error::@realm/react is $got_react, expected $want_react" >&2; exit 1; }
for pair in "realm $want_realm" "@realm/react $want_react"; do
  read -r dir spec <<<"$pair"
  read -r resolved integrity <<<"$(lock "$dir")"
  if [ -n "$registry" ]; then
    expected=$(npm view "$spec" dist.integrity)
    case "$resolved" in https://registry.npmjs.org/*) ;; *) echo "::error::$dir resolved from $resolved" >&2; exit 1 ;; esac
    [ "$integrity" = "$expected" ] || { echo "::error::$dir integrity $integrity, registry $expected" >&2; exit 1; }
    echo "$dir: $spec from $resolved, integrity $integrity (same as npm view $spec dist.integrity)" >&2
  else
    echo "$dir: $spec from $resolved" >&2
  fi
done
if [ -z "$registry" ]; then shasum -a 256 ../bridge/out/*.tgz ../react/out/*.tgz >&2; fi
echo "react-native: $(info react-native)" >&2
echo "$got_realm"
