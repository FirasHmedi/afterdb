#!/usr/bin/env bash
# Runs the example's self-check (scripts/android-selfcheck.sh: 2 launches) from an APK that holds a single ABI,
# then launches the app a third time and checks that the process loaded lib/<abi>/librealm.so of that APK
# (scripts/android-loaded-realm.sh). On an x86_64 image, armeabi-v7a code runs through the image's ARM translation.
# Usage: scripts/android-abi-check.sh <app.apk> <package> <abi> <out dir>
set -euo pipefail
APK="$1"; PKG="$2"; ABI="$3"; OUT="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
abis=$(adb shell getprop ro.product.cpu.abilist | tr -d '\r')
echo "device: Android $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r')), ro.product.cpu.abi $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
echo "ro.product.cpu.abilist: $abis"
echo "ro.dalvik.vm.native.bridge: $(adb shell getprop ro.dalvik.vm.native.bridge | tr -d '\r')"
grep -qE "(^|,)$ABI(,|$)" <<<"$abis" || { echo "::error::this image does not list $ABI in ro.product.cpu.abilist"; exit 1; }
# the APK must hold this ABI only, so the device cannot pick another one
dirs=$(unzip -Z1 "$APK" 'lib/*' | cut -d/ -f2 | sort -u | tr '\n' ' ')
echo "ABIs in the APK: $dirs"
[ "$dirs" = "$ABI " ] || { echo "::error::$APK holds $dirs, expected $ABI only"; exit 1; }

bash "$HERE/android-selfcheck.sh" "$APK" "$PKG" "$OUT/selfcheck-$ABI.png"

primary=$(adb shell dumpsys package "$PKG" | tr -d '\r' | sed -n 's/.*primaryCpuAbi=\([^ ]*\).*/\1/p' | head -1)
echo "primaryCpuAbi: $primary"
[ "$primary" = "$ABI" ] || { echo "::error::primaryCpuAbi is $primary, expected $ABI"; exit 1; }

# third launch: the self-check again, and the mapped librealm.so while the app runs
adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
ok=""
for _ in $(seq 1 90); do
  ui="$(adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb exec-out cat /sdcard/ui.xml 2>/dev/null || true)"
  if grep -q "package=\"$PKG\"" <<<"$ui" && grep -q 'AFTERDB_SELF_CHECK_OK' <<<"$ui"; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { echo "::error::launch 3: no AFTERDB_SELF_CHECK_OK on screen"; exit 1; }
echo "launch 3: $(grep -oE 'AFTERDB_SELF_CHECK_[A-Z]+|launches: [0-9]+' <<<"$ui" | tr '\n' ' ')"
bash "$HERE/android-loaded-realm.sh" "$PKG" "$APK" "$ABI"
adb shell am force-stop "$PKG"
echo "ABI check OK: $ABI"
