#!/usr/bin/env bash
# Records what happens when an app is launched once on a running emulator, for an app that may crash at start
# (used in .github/workflows/upgrade.yml for the official realm@20.2.0 armeabi-v7a APK under ARM translation).
# Installs the APK, launches it and waits for a crash of the package or for its own screen. On a native crash:
# the crash lines from logcat, the header and backtrace of the tombstone, and which registers point into <lib>
# of that APK (scripts/crash-in-lib.py: offset in the library, nearest exported symbol, the call before it).
# Also lists, for <lib> in this APK and in the other APKs given, whether it imports a few libc functions that a
# CPU feature probe can use.
# Exit status: 0 a native crash was recorded, 2 the app showed its screen without crashing, 1 anything else.
# Usage: scripts/android-start-crash.sh <app.apk> <package> <lib, e.g. librealm.so> <out dir> [other.apk ...]
set -euo pipefail
APK="$1"; PKG="$2"; LIB="$3"; OUT="$4"; shift 4
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
ndk="${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_ROOT:-$(ls -d "$sdk"/ndk/* | sort -V | tail -1)}}"
bin=$(ls -d "$ndk"/toolchains/llvm/prebuilt/*/bin | head -1)
[ -x "$bin/llvm-objdump" ] || { echo "::error::no llvm-objdump in $ndk"; exit 1; }

# the library from the APK (one ABI per APK)
so=$(unzip -Z1 "$APK" "lib/*/$LIB")
[ "$(wc -l <<<"$so")" -eq 1 ] || { echo "::error::$APK holds $LIB for several ABIs or none: $so"; exit 1; }
unzip -p "$APK" "$so" > "$OUT/$LIB"
echo "$APK: $so, SHA-256 $(shasum -a 256 "$OUT/$LIB" | awk '{print $1}')"
echo "device: Android $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r')), ABIs $(adb shell getprop ro.product.cpu.abilist | tr -d '\r'), native bridge $(adb shell getprop ro.dalvik.vm.native.bridge | tr -d '\r')"

# tombstones are readable as root (emulator google_apis images)
adb root >/dev/null 2>&1 || true
adb wait-for-device
adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install "$APK" >/dev/null
adb logcat -b main -b system -b crash -c || true
adb shell am start -n "$PKG/.MainActivity" >/dev/null
state=""
for _ in $(seq 1 45); do
  if adb logcat -d -b crash 2>/dev/null | grep -qE ">>> $PKG <<<|Process: $PKG,"; then state=crash; break; fi
  ui="$(adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb exec-out cat /sdcard/ui.xml 2>/dev/null || true)"
  if grep -q "package=\"$PKG\"" <<<"$ui"; then state=screen; break; fi
  sleep 2
done
adb logcat -d -b main -b system -b crash > "$OUT/logcat.txt" 2>/dev/null || true
if [ "$state" = screen ]; then
  sleep 5
  if ! adb logcat -d -b crash 2>/dev/null | grep -qE ">>> $PKG <<<|Process: $PKG,"; then
    adb shell am force-stop "$PKG"
    echo "the app showed its screen and did not crash"
    exit 2
  fi
fi
if ! grep -qE "F DEBUG +: .*>>> $PKG <<<" "$OUT/logcat.txt"; then
  adb shell am force-stop "$PKG"
  echo "::error::no native crash of $PKG in logcat and no screen of the app (state: ${state:-none})"
  grep -E "AndroidRuntime|$PKG" "$OUT/logcat.txt" | tail -40 || true
  exit 1
fi
echo "crash lines in logcat:"
grep -E ' F (libc|DEBUG) +:' "$OUT/logcat.txt" | awk 'NR <= 20 { print "  " $0 }'
pid=$(awk -v k=">>> $PKG <<<" '/ F DEBUG +: pid: / && index($0, k) { sub(/.* pid: /, ""); sub(/,.*/, ""); print; exit }' "$OUT/logcat.txt")

# the tombstone of that process (tombstoned writes it a moment after the crash lines)
tomb=""
for _ in $(seq 1 15); do
  for t in $(adb shell ls -t /data/tombstones 2>/dev/null | tr -d '\r' | grep -E '^tombstone_[0-9]+$' || true); do
    adb shell cat "/data/tombstones/$t" 2>/dev/null | tr -d '\r' > "$OUT/tombstone.txt" || true
    if grep -qE "^pid: $pid, .*>>> $PKG <<<" "$OUT/tombstone.txt"; then tomb="$OUT/tombstone.txt"; break; fi
  done
  [ -n "$tomb" ] && break
  sleep 2
done
adb shell am force-stop "$PKG"
[ -n "$tomb" ] || { echo "::error::no tombstone for pid $pid of $PKG in /data/tombstones"; exit 1; }
echo "tombstone of pid $pid, crashed thread:"
awk '/^pid: /{p=1} p{print "  " $0} p && /^backtrace:/{b=1; next} b && !/^ +#/{exit}' "$tomb"
python3 -I "$HERE/crash-in-lib.py" "$tomb" "$OUT/$LIB" "$bin"

echo "imports of $LIB (U = imported):"
for apk in "$APK" "$@"; do
  f=$(mktemp)
  unzip -p "$apk" "$(unzip -Z1 "$apk" "lib/*/$LIB" | awk 'NR == 1')" > "$f"
  list=$("$bin/llvm-nm" -D --undefined-only "$f" | awk '{ sub(/@.*/, "", $2); print $2 }' | sort -u)
  row=""
  for fn in getauxval sigsetjmp siglongjmp sigprocmask sigaction bsd_signal signal; do
    if grep -qxF "$fn" <<<"$list"; then row="$row $fn:U"; else row="$row $fn:-"; fi
  done
  echo "  $apk:$row"
  rm -f "$f"
done
exit 0
