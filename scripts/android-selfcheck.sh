#!/usr/bin/env bash
# Runs the example app on a running Android emulator twice and checks the screen: AFTERDB_SELF_CHECK_OK,
# then "launches: 1" and "launches: 2" (data kept after a force-stop). Release builds cannot be read with
# run-as, so the text is read with uiautomator.
# Usage: scripts/android-selfcheck.sh <app.apk> <package> <screenshot.png>
set -euo pipefail
APK="$1"; PKG="$2"; SHOT="$3"
adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install -r "$APK" >/dev/null
adb logcat -c || true
front() { grep -o 'package="[^"]*"' <<<"$1" | sort | uniq -c | sort -rn | head -3 | tr -s ' ' | tr '\n' ';' || true; }
for n in 1 2; do
  # close system dialogs (an "isn't responding" dialog of a slow emulator can cover the app)
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
  adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
  ok=""
  ui=""
  for i in $(seq 1 90); do
    ui="$(adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb exec-out cat /sdcard/ui.xml 2>/dev/null || true)"
    # the screen must belong to this app (an emulator snapshot or a system dialog can be in front)
    if ! grep -q "package=\"$PKG\"" <<<"$ui"; then
      if grep -qiE "isn.t responding|aerr_wait|aerr_close" <<<"$ui"; then
        adb shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
        adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
      fi
      # every 30 tries, bring the app back to the front
      if [ $((i % 30)) = 0 ]; then adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true; fi
      sleep 2; continue
    fi
    if grep -q 'AFTERDB_SELF_CHECK_OK' <<<"$ui" && grep -q "launches: $n\"" <<<"$ui"; then ok=1; break; fi
    if grep -qE 'AFTERDB_SELF_CHECK_(FAILED|ERROR)' <<<"$ui"; then break; fi
    sleep 2
  done
  if [ "$n" = 2 ] || [ -z "$ok" ]; then adb exec-out screencap -p > "$SHOT" 2>/dev/null || true; fi
  echo "launch $n: $(grep -oE 'AFTERDB_SELF_CHECK_[A-Z]+[^"]*|launches: [0-9a-z ]+' <<<"$ui" | tr '\n' ' ' || true)"
  adb shell am force-stop "$PKG"
  if [ -z "$ok" ]; then
    echo "::error::self-check not OK on launch $n (packages on screen: $(front "$ui"))"
    adb logcat -d -s ReactNativeJS:V AndroidRuntime:E | tail -50
    exit 1
  fi
done
# only crashes of this app count (system apps of the emulator image crash now and then)
if adb logcat -d | grep -A1 'FATAL EXCEPTION' | grep -qF "Process: $PKG,"; then
  echo "::error::FATAL in logcat for $PKG"; adb logcat -d | grep -A20 'FATAL EXCEPTION' | head -60; exit 1
fi
others=$(adb logcat -d | grep -A1 'FATAL EXCEPTION' | grep -o 'Process: [^,]*' | sort -u | tr '\n' ' ' || true)
[ -z "$others" ] || echo "note: crashes of other processes on the emulator (not counted): $others"
echo "Android self-check OK on both launches (data kept after a restart)"
