#!/usr/bin/env bash
# Checks that every librealm.so in an APK holds OpenSSL <version> and no other OpenSSL 3.x version string
# (the version that OpenSSL's built-in provider reports, e.g. "3.3.1" for the official realm@20.2.0 build,
# "3.5.9" for afterdb 20.3.0). Prints the ABIs found.
# Usage: scripts/apk-openssl.sh <app.apk> <version>
set -euo pipefail
APK="$1"; WANT="$2"
libs=$(unzip -Z1 "$APK" 'lib/*/librealm.so')
[ -n "$libs" ] || { echo "::error::no librealm.so in $APK"; exit 1; }
for so in $libs; do
  found=$(unzip -p "$APK" "$so" | strings -a -n 5 | grep -xE '3\.[0-9]+\.[0-9]+' | sort -u | tr '\n' ' ')
  echo "$so: OpenSSL version strings: ${found:-none}"
  [ "$found" = "$WANT " ] || { echo "::error::$so: expected OpenSSL $WANT only, found: ${found:-none}"; exit 1; }
done
