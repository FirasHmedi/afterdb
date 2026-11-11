#!/usr/bin/env bash
# In-place upgrade test on a running Android emulator (upgrade mode of the example app, example/upgrade/data.ts):
# 1. install A (built with the official realm), launch: it writes generation 1 to a plain and an encrypted file;
# 2. adb install -r B (built with afterdb: same application id, same signing key), launch: it checks every object
#    of generation 1 against the generator and the recorded SHA-256, then writes generation 2;
# 3. adb install -r -d A again, launch: it checks generations 1 and 2, then writes generation 3.
# Each launch must show "AFTERDB_UPGRADE_OK stage=<n> history=<writers> items=<n x 120>" (read with uiautomator).
# A and B may hold different ABIs (one each): on an x86_64 image with ARM translation, A can be the x86_64 build
# and B the armeabi-v7a build; the files stay in place when the update changes the app's ABI.
# With CHECK_LOADED=1, also checks after each stage that the process loaded lib/<abi>/librealm.so of the APK
# that was installed (scripts/android-loaded-realm.sh).
# Usage: scripts/android-upgrade.sh <A.apk> <A writer> <B.apk> <B writer> <package> <out dir>
#   writer: name@version of the package installed as "realm" in that build, e.g. realm@20.2.0
set -euo pipefail
A="$1"; WA="$2"; B="$3"; WB="$4"; PKG="$5"; OUT="$6"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
bt=$(ls -d "$sdk"/build-tools/* | sort -V | tail -1)
pkgname() { "$bt/aapt2" dump badging "$1" | sed -n "s/^package: name='\([^']*\)'.*/\1/p"; }
cert() { "$bt/apksigner" verify --print-certs "$1" | awk -F'SHA-256 digest: ' '!f && NF > 1 { print $2; f = 1 }'; }
# ABI of the librealm.so in an APK (one ABI per APK)
abi() {
  local dirs
  dirs=$(unzip -Z1 "$1" 'lib/*/librealm.so' | cut -d/ -f2 | sort -u | tr '\n' ' ')
  [ "$(wc -w <<<"$dirs")" -eq 1 ] || { echo "::error::$1 holds librealm.so for: ${dirs:-none} (expected one ABI)" >&2; return 1; }
  echo "${dirs% }"
}

# same application id and same signing certificate: otherwise install -r fails or installs another app
for apk in "$A" "$B"; do
  name=$(pkgname "$apk")
  [ "$name" = "$PKG" ] || { echo "::error::$apk: package $name, expected $PKG"; exit 1; }
done
ca=$(cert "$A"); cb=$(cert "$B")
{ [ -n "$ca" ] && [ "$ca" = "$cb" ]; } || { echo "::error::signing certificates differ: A $ca, B $cb"; exit 1; }
abi_a=$(abi "$A"); abi_b=$(abi "$B")
echo "A: $A ($WA, $abi_a)"
echo "B: $B ($WB, $abi_b)"
echo "both: package $PKG, signing certificate SHA-256 $ca"
echo "device: Android $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r')), ABIs $(adb shell getprop ro.product.cpu.abilist | tr -d '\r')"

# first line of dumpsys package that contains $1 (awk reads all input: no SIGPIPE under pipefail)
installed() { adb shell dumpsys package "$PKG" | tr -d '\r' | awk -v k="$1" '!f && index($0, k) { sub(/^ */, ""); print; f = 1 }'; }

stage() { # <n> <expected history> <apk>
  local n="$1" apk="$3" ui="" ok="" crashed=""
  local want="AFTERDB_UPGRADE_OK stage=$n history=$2 items=$((n * 120))"
  echo "== stage $n: $(installed versionCode) $(installed lastUpdateTime) $(installed primaryCpuAbi)"
  adb logcat -b main -b system -b crash -c || true
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
  adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
  for i in $(seq 1 120); do
    ui="$(adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb exec-out cat /sdcard/ui.xml 2>/dev/null || true)"
    # the screen must belong to this app (a system dialog can be in front on a slow emulator)
    if ! grep -q "package=\"$PKG\"" <<<"$ui"; then
      if grep -qiE "isn.t responding|aerr_wait|aerr_close" <<<"$ui"; then
        adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
        adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
      fi
      # a crash of this app (native or Java) ends the stage at once
      if adb logcat -d -b crash 2>/dev/null | grep -qE ">>> $PKG <<<|Process: $PKG,"; then crashed=1; break; fi
      if [ $((i % 30)) = 0 ]; then adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true; fi
      sleep 2; continue
    fi
    if grep -qF "text=\"$want\"" <<<"$ui"; then ok=1; break; fi
    if grep -qE 'AFTERDB_UPGRADE_(FAILED|ERROR)' <<<"$ui"; then break; fi
    sleep 2
  done
  adb exec-out screencap -p > "$OUT/stage-$n.png" 2>/dev/null || true
  printf '%s\n' "$ui" > "$OUT/stage-$n-screen.xml"
  echo "screen: $(grep -oE 'AFTERDB_UPGRADE_[A-Z]+[^"]*' <<<"$ui" | head -1 || true)"
  echo "        $(grep -oE '(built with|plain:|encrypted:) [^"]*' <<<"$ui" | tr '\n' ';' || true)"
  if [ -n "$ok" ] && [ "${CHECK_LOADED:-}" = 1 ]; then bash "$HERE/android-loaded-realm.sh" "$PKG" "$apk" "$(abi "$apk")" || ok=""; fi
  adb logcat -d -b main -b system -b crash > "$OUT/stage-$n-logcat.txt" 2>/dev/null || true
  adb shell am force-stop "$PKG"
  if [ -z "$ok" ]; then
    if [ -n "$crashed" ]; then echo "::error::stage $n: $PKG crashed"; fi
    echo "::error::stage $n: the screen does not show \"$want\""
    grep -E 'ReactNativeJS|AndroidRuntime|libc|DEBUG' "$OUT/stage-$n-logcat.txt" | tail -60 || true
    exit 1
  fi
  if grep -qE ">>> $PKG <<<|Process: $PKG," "$OUT/stage-$n-logcat.txt"; then
    echo "::error::stage $n: $PKG crashed"; exit 1
  fi
}

adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install "$A" >/dev/null
first=$(installed firstInstallTime)
stage 1 "$WA" "$A"
adb install -r "$B" >/dev/null
stage 2 "$WA,$WB" "$B"
adb install -r -d "$A" >/dev/null
stage 3 "$WA,$WB,$WA" "$A"
# updated in place every time, never uninstalled
[ "$(installed firstInstallTime)" = "$first" ] || { echo "::error::$first changed: the app was reinstalled"; exit 1; }
echo "Upgrade test OK: $WA -> $WB -> $WA, data kept in place ($first)"
