#!/usr/bin/env bash
# Shows which librealm.so the running app process has loaded, and fails unless it is lib/<abi>/librealm.so of
# the given APK. Reads /proc/<pid>/maps as root (emulator google_apis images). Native libraries stored
# uncompressed in the APK are mapped from base.apk: the mapped offsets are matched to the APK's zip entries.
# Also prints the process binary (app_process32 or app_process64: the ISA the process runs natively), the app's ABI
# as seen by the package manager, and the native bridge library when the image has one (zygote maps it in every app
# process, so its presence alone does not mean that the app runs translated code).
# Usage: scripts/android-loaded-realm.sh <package> <app.apk> <abi>   (the app must be running)
set -euo pipefail
PKG="$1"; APK="$2"; ABI="$3"
pid=$(adb shell pidof "$PKG" | tr -d '\r' | awk '{print $1}')
[ -n "$pid" ] || { echo "::error::$PKG is not running"; exit 1; }
# root shell (adbd restarts as root on emulator images without Play Store; the app keeps running), else su
adb root >/dev/null 2>&1 || true
adb wait-for-device
as_root() { { adb shell "$@" 2>/dev/null || true; } | tr -d '\r'; }
maps=$(mktemp)
as_root cat "/proc/$pid/maps" | grep -E '^[0-9a-f]+-[0-9a-f]+ ' > "$maps.clean" || true
if ! [ -s "$maps.clean" ]; then
  as_root su 0 cat "/proc/$pid/maps" | grep -E '^[0-9a-f]+-[0-9a-f]+ ' > "$maps.clean" || true
fi
[ -s "$maps.clean" ] || { echo "::error::cannot read /proc/$pid/maps (no root shell)"; exit 1; }
exe=$(as_root readlink "/proc/$pid/exe")
[ -n "$exe" ] || exe=$(as_root su 0 readlink "/proc/$pid/exe")
echo "process $pid ($PKG), binary ${exe:-unknown}"
adb shell dumpsys package "$PKG" | tr -d '\r' | grep -E 'primaryCpuAbi|secondaryCpuAbi' | sed 's/^ */  /' || true
bridge=$(grep -oE '[^ ]*(libndk_translation|libhoudini)[^ ]*\.so' "$maps.clean" | sort -u | head -3 | tr '\n' ' ' || true)
echo "  native bridge library mapped (in every app process of this image): ${bridge:-none}"
loaded=$(python3 -I - "$APK" "$maps.clean" <<'PY'
import sys, zipfile
apk, maps = sys.argv[1], sys.argv[2]
ranges = []
with zipfile.ZipFile(apk) as z, open(apk, 'rb') as f:
    for e in z.infolist():
        f.seek(e.header_offset)
        h = f.read(30)
        start = e.header_offset + 30 + int.from_bytes(h[26:28], 'little') + int.from_bytes(h[28:30], 'little')
        ranges.append((start, start + e.compress_size, e.filename))
found = set()
for line in open(maps):
    parts = line.split()
    if len(parts) < 6:
        continue
    path = parts[5]
    if path.endswith('/base.apk'):
        off = int(parts[2], 16)
        found.update(name for s, t, name in ranges if s <= off < t and name.endswith('.so'))
    elif path.endswith('/librealm.so'):
        found.add(path)
print('\n'.join(sorted(found)))
PY
)
echo "  native libraries of the app mapped in the process:"
sed 's/^/    /' <<<"$loaded"
rm -f "$maps" "$maps.clean"
case "$ABI" in armeabi-v7a) isa=arm ;; arm64-v8a) isa=arm64 ;; *) isa="$ABI" ;; esac
if grep -qxF "lib/$ABI/librealm.so" <<<"$loaded" || grep -qE "/lib/$isa/librealm\.so$" <<<"$loaded"; then
  echo "  librealm.so loaded: $ABI"
else
  echo "::error::lib/$ABI/librealm.so of $APK is not mapped in process $pid"
  exit 1
fi
