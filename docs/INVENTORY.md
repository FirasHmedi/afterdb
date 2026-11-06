# Inventory: how realm@20.2.0 is built and shipped

Read from the official npm tarball `realm@20.2.0` of the Realm® JavaScript SDK (published 2025-08-11, integrity
checked by `bridge/build.mjs`). Realm® is a trademark of MongoDB, Inc.; afterdb is not affiliated with or endorsed by
MongoDB.

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

Note for this repository: `npm ci` in `converter/` installs the upstream `realm` package, whose install script
downloads the Node binary from static.realm.io. To avoid it, install with `--ignore-scripts` and our tarball
(`bridge/out/*.tgz`) in its place.

## Key files
- `RealmJS.podspec`: sources of the binding, `vendored_frameworks` = the xcframework, C++20 flags, the leftover
  `REALM_ENABLE_SYNC=1` define (no shipped header or binding source reads it), and a minimum of iOS 9.0.
- `binding/android/CMakeLists.txt` + `build.gradle`: builds `librealm.so` for the app from the binding sources and
  the prebuilt `.a` files, with `-Wl,-z,max-page-size=16384` (16 KB pages). `build.gradle` sets no `ndkVersion`, so
  AGP's default NDK builds `librealm.so`, not the app's.
- `prebuilds/android/<abi>/share/cmake/Realm/RealmConfig.cmake`: imports the realm-core targets and acquires OpenSSL.

## What afterdb changes
See `CHANGES-FROM-UPSTREAM.md`. In short (`@pomwik/afterdb` 20.3.0): no install script, all binaries and OpenSSL
bundled, podspec fixed for React Native >= 0.86 and its minimum iOS version, s2 macros that no longer specialize
`std::is_pod` (the Xcode 26.4 error of realm/realm-js#7115), OpenSSL 3.5.9 LTS on Android with its SHA-256 checked
by CMake, the app's NDK for `librealm.so`. realm-core is not rebuilt. `@pomwik/afterdb-react` 0.20.1 repackages
`@realm/react@0.20.0` with `react-native` as an optional peer.

## Failures reproduced so far
See `docs/TEST-RESULTS.md`.
