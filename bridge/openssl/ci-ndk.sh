#!/usr/bin/env bash
# GitHub Actions: installs the Android NDK pinned in build-openssl.sh (NDK_VERSION) when the runner does not have it,
# exports ANDROID_NDK_ROOT for the next steps and writes the version as the step output "version".
# Usage (in a workflow step): bash bridge/openssl/ci-ndk.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
v="$(sed -n 's/^NDK_VERSION=//p' "$HERE/build-openssl.sh")"
[ -n "$v" ] || { echo "::error::NDK_VERSION not found in bridge/openssl/build-openssl.sh"; exit 1; }
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -d "$sdk" ] || { echo "::error::no Android SDK (ANDROID_HOME)"; exit 1; }
echo "NDKs in $sdk/ndk:"; ls -1 "$sdk/ndk" 2>/dev/null || true
if [ ! -f "$sdk/ndk/$v/source.properties" ]; then
  echo "NDK $v is not on this runner: installing it"
  (yes || true) | "$sdk/cmdline-tools/latest/bin/sdkmanager" --install "ndk;$v" >/dev/null
fi
rev="$(sed -n 's/^Pkg\.Revision *= *//p' "$sdk/ndk/$v/source.properties" | tr -d '\r')"
[ "$rev" = "$v" ] || { echo "::error::$sdk/ndk/$v holds NDK $rev"; exit 1; }
echo "Using NDK $v ($sdk/ndk/$v)"
echo "ANDROID_NDK_ROOT=$sdk/ndk/$v" >> "$GITHUB_ENV"
echo "version=$v" >> "$GITHUB_OUTPUT"
