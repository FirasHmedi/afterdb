# afterdb

An independent, maintained fork of the open-source realm-js SDK v20 (local database, no sync) for apps that use
Realm® and need current React Native, Expo and Xcode, plus tools to migrate their data to SQLite. Free and open source
(Apache-2.0).

> Realm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB.

## Why it exists

MongoDB deprecated Realm and Device Sync on 30 September 2025. The last `realm` release is 20.2.0 (August 2025) and
nobody is paid to maintain it any more (realm/realm-js#7094). Apps still ship on it, and each React Native, Expo or
Xcode upgrade tends to break it. afterdb keeps those apps building while their teams decide whether to stay or move.

## What is in this repository

| Folder | What | Status |
|---|---|---|
| `bridge/` | `@pomwik/afterdb`: the official `realm@20.2.0` package, verified, with build fixes (no engine change) | Built and tested |
| `react/` | `@pomwik/afterdb-react`: `@realm/react@0.20.0` with `react-native` as an optional peer | Built and tested |
| `converter/` | `afterdb-convert`: `.realm` → SQLite with per-object verification, and an RQL ↔ SQL differential test | Tested on desktop (Node) |
| `example/` | React Native 0.88.1 app that installs both packages under the names `realm` and `@realm/react` (local `file:` tarballs, as the npm alias would) and runs a self-check | See the matrix |
| `scripts/check-16kb.mjs` | Checks that every 64-bit `.so` of an APK/AAB is 16 KB aligned (Google Play, 1 Feb 2027), and runs `zipalign -P 16` if found | Tested (`node --test scripts/check-16kb.test.mjs`), run in CI |

Fixes compared with `realm@20.2.0` (details and credits in `CHANGES-FROM-UPSTREAM.md`):
- iOS linking on React Native >= 0.86 with frameworks (realm/realm-js#7157, fix by TPXP);
- Xcode 26.4 `is_pod` build error from a shipped header (#7115);
- no install-time download and no analytics: Node binaries for 5 platforms are in the package (#7119, #7068, #7126);
- Android builds no longer download OpenSSL at compile time, and ship OpenSSL 3.5.9 LTS instead of the end-of-life 3.3.1 (#7044);
- `@realm/react` no longer pulls a nested copy of react-native (#7066).

## Compatibility matrix

Only what has actually been run is marked as passing. See `docs/TEST-RESULTS.md` for the details and the logs.
"CI" means a green run of the GitHub Actions workflow; "local" means run on the maintainer's machine.

| Area | Status |
|---|---|
| Node 22: install offline, open, write, query, encrypted realm | Pass (`npm test`: macOS arm64 local, Linux x64 CI) |
| realm-js's own Node integration tests and `@realm/react` tests, compared with upstream 20.2.0 (local, macOS arm64 only) | Node: 645 tests, identical results test by test; `@realm/react`: same results in 35 of 36 runs (one run froze under machine load) |
| Android, React Native 0.88.1, new architecture, Hermes: Debug and Release builds, 4 ABIs, OpenSSL 3.5.9 LTS | Pass (local and CI) |
| Android app run (13-check self-check, data kept after a restart): Android 7 (minimum), 11, 16, and 16 with **16 KB pages** | Pass (emulators, CI; 16 KB pages also local) |
| React Native 0.86.3 and 0.87.1 (bare), Expo SDK 56 (RN 0.85.3), 57 (RN 0.86.3) and 58 (RN 0.88.1) on Android | Pass (local emulator, 16 KB pages; RN 0.86.3 and 0.87.1 rerun with the current packages, `librealm.so` built with the app's NDK) |
| Release builds with R8 (Expo 58 default, or `minifyEnabled`) | Pass: the package ships its keep rules (local) |
| 16 KB alignment of every 64-bit native library, `zipalign -P 16` | Pass (local and CI) |
| No download from static.realm.io during `npm install` or the Android build | Pass (local; OpenSSL origin checked in CI) |
| iOS, React Native 0.88.1, **Xcode 26.4.1** (simulator iOS 26.4), no frameworks: Debug and Release builds, app run (13 checks, data kept after a restart), device build | Pass (CI) |
| iOS, React Native 0.88.1, Xcode 26.6 (simulator iOS 26.5): dynamic frameworks (13 checks), static and no frameworks (first version of the self-check): Release build, app run, device build | Pass (CI) |
| iOS on a real iPhone; iOS with React Native 0.86/0.87 or Expo | Not run yet |

All dates: 2026-11-06.

## Install (bare React Native)

```json
"dependencies": {
  "realm": "npm:@pomwik/afterdb@20.3.0",
  "@realm/react": "npm:@pomwik/afterdb-react@0.20.1"
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
- Debug builds on React Native 0.83 and later (React 19.2 and later): React's performance track reads the props of
  rendered components, including Realm objects that were just deleted, and reading a deleted Realm object throws.
  Release builds are not affected. This is a React bug (facebook/react#35126); a fix is proposed in facebook/react#36867
  but not merged (see also realm/realm-js#7086). To avoid it: key list rows by primary key, or pass ids and read
  the object with `useObject`; update embedded objects in place instead of replacing them; or patch React Native's
  dev renderer with patch-package.

## Development

From scratch, build OpenSSL first (needs the Android NDK 27.*, found through `ANDROID_NDK_ROOT` or
`$ANDROID_HOME/ndk/27.*`): `npm run build` stops if the OpenSSL archives are missing.

```bash
bridge/openssl/build-openssl.sh   # OpenSSL 3.5.9 for the 4 Android ABIs, into bridge/.cache/openssl/
npm run build          # downloads realm@20.2.0 and @realm/react@0.20.0 from npm, checks them, patches, packs
npm test               # tests of the built packages, including an offline install and a Node smoke test
node --test scripts/check-16kb.test.mjs
cd converter && npm test
cd example && npm install && npm run build:android
node scripts/check-16kb.mjs example/android/app/build/outputs/apk/release/app-release.apk
```

Every upstream download is checked against a pinned hash, and the build stops on a mismatch. `npm run build` checks
the npm integrity of `realm@20.2.0` and `@realm/react@0.20.0` and the SHA-256 of the 5 upstream Node binaries;
`build-openssl.sh` checks the SHA-256 of the OpenSSL source release and of the upstream OpenSSL 3.3.1 archive whose
`include.cmake` is reused.

## Reporting issues

Open an issue with your versions of afterdb, React Native, Expo, Xcode or the Android NDK, and the full error.
Security problems: see `SECURITY.md`.

## Need help?

Diagnostic of your Realm app, migration of your data to SQLite at a fixed price, or fixes after each React Native,
Expo or Xcode release, under a support agreement: [pomwik.com/realm](https://pomwik.com/realm/) or hello@pomwik.com.

## Licence

Apache-2.0, converter included. See `LICENSE`, `NOTICE` and `CHANGES-FROM-UPSTREAM.md`. The prebuilt realm-core
engine shipped in `@pomwik/afterdb` contains third-party code under other licences: see `THIRD-PARTY-NOTICES.md`.

Exceptions: `example/` contains files from the React Native app template, under the MIT licence (Copyright (c)
Meta Platforms, Inc. and affiliates; text in `example/LICENSE-template`), and its Gradle wrapper files keep their
own Apache-2.0 headers. `examples/expo-58/` started from Expo's `blank-typescript` template (Expo, 650 Industries,
Inc.), published under the 0BSD licence.
