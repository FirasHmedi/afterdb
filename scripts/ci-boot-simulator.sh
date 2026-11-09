#!/usr/bin/env bash
# CI (macOS runners): boots an iPhone simulator on the newest iOS runtime not newer than the selected Xcode's
# simulator SDK (an older Xcode may not run a later runtime), and exports SIM_UDID to the next steps.
set -euo pipefail
SDK=$(xcrun --sdk iphonesimulator --show-sdk-version)
export SDK
echo "iphonesimulator SDK $SDK"
udid=$(xcrun simctl list devices available -j | python3 -c '
import json, os, re, sys
d = json.load(sys.stdin)["devices"]
sdk = [int(x) for x in os.environ["SDK"].split(".")][:2]
ver = lambda k: [int(x) for x in re.findall(r"\d+", k)]
ios = sorted((k for k in d if "iOS" in k and ver(k)[:2] <= sdk), key=ver)
for rt in reversed(ios):
    phones = [x for x in d[rt] if x["name"].startswith("iPhone")]
    if phones:
        print(phones[0]["udid"], rt, phones[0]["name"], file=sys.stderr)
        print(phones[0]["udid"])
        break
')
[ -n "$udid" ] || { echo "::error::no iPhone simulator available"; exit 1; }
xcrun simctl bootstatus "$udid" -b
echo "SIM_UDID=$udid" >> "$GITHUB_ENV"
