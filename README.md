# keelstore (placeholder name)

A maintained build of the Realm JS SDK v20 (local database, no sync) for current React Native, Expo and Xcode,
plus tools to migrate Realm data to SQLite. Free and open source (Apache-2.0).

> Realm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB.

## Why it exists

MongoDB deprecated Realm and Device Sync on 30 September 2025. The last `realm` release is 20.2.0 (August 2025) and
nobody is paid to maintain it any more (realm/realm-js#7094). Apps still ship on it, and each React Native, Expo or
Xcode upgrade tends to break it. keelstore keeps those apps building while their teams decide whether to stay or move.

## What is in this repository

| Folder | What | Status |
|---|---|---|
| `bridge/` | `@pomwik/keelstore`: the official `realm@20.2.0` package, verified, with build fixes (no engine change) | Built and tested |
| `react/` | `@pomwik/keelstore-react`: `@realm/react@0.20.0` with `react-native` as an optional peer | Built and tested |
| `converter/` | `keel-convert`: `.realm` → SQLite with per-object verification, and an RQL ↔ SQL differential test | Tested on desktop (Node) |
| `example/` | React Native 0.88.1 app that uses both packages through npm aliases and runs a self-check | See the matrix |
| `scripts/check-16kb.mjs` | Checks that every `.so` of an APK/AAB is 16 KB aligned (Google Play, 1 Feb 2027) | Used in CI |

Fixes compared with `realm@20.2.0` (details and credits in `CHANGES-FROM-UPSTREAM.md`):
- iOS linking on React Native >= 0.86 with frameworks (realm/realm-js#7157, fix by TPXP);
- Xcode 26.4 `is_pod` build error from a shipped header (#7115);
- no install-time download and no analytics: Node binaries for 5 platforms are in the package (#7119, #7068, #7126);
- Android builds no longer download OpenSSL at compile time (#7044);
- `@realm/react` no longer pulls a nested copy of react-native (#7066).

## Compatibility matrix

Only what has actually been run is marked as passing. See `docs/TEST-RESULTS.md` for the logs.

| Area | Status |
|---|---|
| Node 22 (macOS arm64): install offline, open, write, query, encrypted realm | Pass (`npm test`) |
| Android, React Native 0.88.1, new architecture, Hermes, release build | See `docs/TEST-RESULTS.md` |
| 16 KB alignment of the example APK | See `docs/TEST-RESULTS.md` |
| iOS, Xcode 26.4, React Native 0.88.1 (frameworks none / static / dynamic) | Not run yet (CI job, needs macOS runners) |
| React Native 0.86 / 0.87, Expo SDK 56–58 | Not run yet |

## Install (bare React Native)

```json
"dependencies": {
  "realm": "npm:@pomwik/keelstore@20.3.0",
  "@realm/react": "npm:@pomwik/keelstore-react@0.20.1"
}
```

Then reinstall, `pod install` on iOS, and rebuild. Your code keeps `import Realm from "realm"`. Expo dev builds:
the same two lines, then `npx expo prebuild --clean`. Full steps: `MIGRATING-FROM-REALM.md`.

Not published to npm yet: until then, build the packages yourself (`npm run build`, Node 22) and point the two
dependencies at `bridge/out/*.tgz` and `react/out/*.tgz`.

## What is not covered

- Device Sync (removed upstream in v20), the old React Native architecture.
- Bugs inside the realm-core C++ engine (for example realm/realm-js#7061, #7082, #7084): we ship the upstream
  prebuilt engine unchanged.
- Realm Swift, Kotlin and Flutter.
- SwiftPM (React Native 0.89): design note in `docs/SWIFTPM.md`, not implemented yet.

## Development

```bash
npm run build          # downloads realm@20.2.0 and @realm/react@0.20.0 from npm, checks their integrity, patches, packs
npm test               # tests of the built packages, including an offline install and a Node smoke test
cd converter && npm test
cd example && npm install && npm run build:android
node scripts/check-16kb.mjs example/android/app/build/outputs/apk/release/app-release.apk
```

## Reporting issues

Open an issue with your versions of keelstore, React Native, Expo, Xcode or the Android NDK, and the full error.
Security problems: see `SECURITY.md`.

## Need help?

Diagnostic of your Realm app, migration of your data to SQLite at a fixed price, or guaranteed fixes after each
React Native, Expo or Xcode release: [pomwik.com/realm](https://pomwik.com/realm/) or hello@pomwik.com.

## Licence

Apache-2.0. See `LICENSE`, `NOTICE` and `CHANGES-FROM-UPSTREAM.md`. The converter will be published under MIT.
