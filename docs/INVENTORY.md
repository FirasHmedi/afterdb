# Inventory: how realm@20.2.0 is built and shipped

Read from the official npm tarball `realm@20.2.0` (published 2025-08-11, integrity checked by `bridge/build.mjs`).

## What the npm tarball contains
- `dist/`: the compiled TypeScript SDK. Node loads `dist/platform/node/index.js`; React Native loads `index.react-native.js`.
- `prebuilds/apple/realm-core.xcframework`: realm-core compiled for iOS device, simulator and Mac Catalyst, with headers.
- `prebuilds/android/<abi>/lib/*.a`: realm-core static libraries for arm64-v8a, armeabi-v7a, x86 and x86_64, plus
  CMake config files in `share/cmake/Realm/`.
- `binding/jsi`, `binding/apple`, `binding/android`, `bindgen/src`: the JSI binding sources. They are compiled **inside
  the app** (CocoaPods on iOS, CMake through Gradle on Android) and link against the prebuilt realm-core.
- No Node binary: the `install` script runs `prebuild-install --runtime napi`, which downloads
  `realm-v20.2.0-napi-v6-<platform>-<arch>.tar.gz` from `https://static.realm.io/realm-js-prebuilds/20.2.0/`.
- No LICENSE file (only `package.json` says Apache-2.0).

## What runs or downloads, and when
| When | What | Where from | Problem |
|---|---|---|---|
| `npm install` | `prebuild-install` fetches the Node binary | static.realm.io | CI hangs and fails offline (realm/realm-js#7119, #7068) |
| `npm install` | `postinstall` runs `submit-analytics.js` (machine id, project info) | — | Breaks some monorepos, sends data (#7126) |
| Android build | `AcquireRealmDependency.cmake` downloads OpenSSL 3.3.1 per ABI | static.realm.io | Network at compile time (#7044); OpenSSL 3.3 is end-of-life since 2026-04-09 |
| iOS `pod install` | `RealmJS.podspec` depends on the umbrella `React` pod | — | Undefined JSI/TurboModule symbols on React Native >= 0.86 with frameworks (#7157) |
| iOS build | `external/s2/base/macros.h` specializes `std::is_pod` | shipped header | Hard error with the libc++ of Xcode 26.4 (#7115) |

## Key files
- `RealmJS.podspec`: sources of the binding, `vendored_frameworks` = the xcframework, C++20 flags, and the leftover
  `REALM_ENABLE_SYNC=1` define (no shipped header or binding source reads it).
- `binding/android/CMakeLists.txt` + `build.gradle`: builds `librealm.so` for the app from the binding sources and
  the prebuilt `.a` files, with `-Wl,-z,max-page-size=16384` (16 KB pages).
- `prebuilds/android/<abi>/share/cmake/Realm/RealmConfig.cmake`: imports the realm-core targets and acquires OpenSSL.

## What keelstore changes
See `CHANGES-FROM-UPSTREAM.md`. In short: no install script, all binaries and OpenSSL bundled, podspec fixed for
React Native >= 0.86, s2 macros made harmless for Xcode 26.4. realm-core is not rebuilt.

## Failures reproduced so far
See `docs/TEST-RESULTS.md`.
