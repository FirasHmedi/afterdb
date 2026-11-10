# Changes from upstream

`@pomwik/afterdb` and `@pomwik/afterdb-react` repackage the official npm tarballs `realm@20.2.0` and
`@realm/react@0.20.0` of the Realm® JavaScript SDK (Apache-2.0). The compiled libraries of the prebuilt realm-core
engine are not recompiled or changed; one of its headers and its Android CMake files are (listed below).

Realm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB.

Every file listed here was modified, removed or added. Modified text files carry a « Modified by Pomwik (Firas
Hmedi), 2026 » note, except `package.json`: JSON has no comments, so it carries an `afterdb` field instead (upstream
name, version and npm integrity).

## @pomwik/afterdb 20.3.0 (from realm@20.2.0)

| File | Change | Why |
|---|---|---|
| `package.json` | `name` and `version` | New package |
| `package.json` | `description`, `homepage`, `repository`, `bugs` and `author` replaced (Pomwik, github.com/FirasHmedi/afterdb); `mongodb` removed from `keywords` | The package is not MongoDB's and must not look like it |
| `package.json` | `license`: `Apache-2.0` instead of upstream's `apache-2.0` (the podspec's `s.license` reads it too) | `Apache-2.0` is the SPDX identifier that npm expects; the licence itself is unchanged |
| `package.json` | `install` and `postinstall` scripts removed; `prebuild-install` and `node-machine-id` dependencies removed; `binary` field removed; `exports["./scripts/submit-analytics"]` removed | No download and no analytics at install time (realm/realm-js#7119, #7068, #7126) |
| `package.json` | `imports["#realm.node"]` removed | Its only user was `dist/platform/node/binding.js` (patched below); the build checks that nothing else in the package refers to it |
| `package.json` | `gypfile: false`; `files`: `binding.gyp` removed, `prebuilds/node`, `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, `CHANGES-FROM-UPSTREAM.md` and `checksums.txt` added | See `binding.gyp` below; the added files ship in the package |
| `package.json` | `afterdb` field added | Marks the file as modified, and records where it comes from |
| `dist/scripts/submit-analytics.*`, `scripts/submit-analytics.js` | Removed | Install-time analytics |
| `prebuilds/node/<platform>-<arch>/realm.node` | Added: the upstream N-API binaries for darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, unchanged. Upstream also serves binaries for linux-arm and win32-ia32 (static.realm.io, 20.2.0); they are not shipped, so on those platforms Node gets the error described in the next row. The Linux binaries contain OpenSSL built from the 3.3.1 sources, end-of-life since 2026-04-09: we cannot rebuild them yet | Installs work offline and in CI |
| `dist/platform/node/binding.js` | Loads the binary of the current platform; if none is shipped for it, throws an error that names the platform and the 5 shipped ones (instead of the upstream `#realm.node` lookup) | Same, and a clear message instead of a module-not-found error |
| `RealmJS.podspec` | `install_modules_dependencies(s)` instead of `s.dependency 'React'` | iOS linking on React Native >= 0.86 with frameworks (realm/realm-js#7157, fix by TPXP, reused with credit) |
| `RealmJS.podspec` | `HEADER_SEARCH_PATHS` is a string instead of an array | React Native's `install_modules_dependencies` appends to it as a string, so the array became `["..."] …` and broke header lookups (found by the independent review) |
| `RealmJS.podspec` | `REALM_ENABLE_SYNC=1` removed from the preprocessor flags, and the upstream comment above it (« compiled with Sync enabled ») replaced | v20 has no sync; no shipped header or binding source reads it |
| `RealmJS.podspec` | `s.platform`: React Native's minimum iOS version (`min_ios_version_supported`) when React Native defines it, otherwise 15.1, instead of iOS 9.0 | 9.0 is far below what React Native >= 0.71 supports |
| `binding/android/build.gradle` | `ndkVersion rootProject.ext.ndkVersion` when the app defines it, as React Native libraries do; otherwise AGP's default, as before | `librealm.so` was built with AGP's default NDK (27.0 with AGP 8.12, 28.2 with AGP 9.2) instead of the app's |
| `binding/android/build.gradle`, new `binding/android/consumer-rules.pro` | `consumerProguardFiles 'consumer-rules.pro'` with `-keep class io.realm.react.** { *; }` | With R8 in the app's release build (on by default in Expo SDK 58), `io.realm.react.util.SSLHelper`, looked up only from native code (`FindClass` in `JNI_OnLoad`), was removed and the app crashed at start with `ClassNotFoundException`. Found with the Expo 58 example on 2026-11-06 |
| `prebuilds/apple/realm-core.xcframework/*/Headers/external/s2/base/macros.h` | `DECLARE_POD` and `PROPAGATE_POD_FROM_TEMPLATE_ARGUMENT` no longer specialize `std::is_pod` | Build error on Xcode 26.4 (realm/realm-js#7115) |
| `prebuilds/android/<abi>/deps/openssl-3.5.9-*.tar.gz` | Added: OpenSSL 3.5.9 LTS built from the checksummed OpenSSL source release by `bridge/openssl/build-openssl.sh` (static, no apps, no engines), entries owned by 0:0. Each archive also holds OpenSSL's `LICENSE.txt` and an `include.cmake` that is upstream's file, byte-identical to the one in realm's `openssl-3.3.1` archives (SHA-256 `00510e01b73e57960852921903df79ca5c9e54086483a349d3d05dff7d1cf28a`) | The Android build no longer downloads anything, and OpenSSL 3.3 is end-of-life since 2026-04-09 |
| `prebuilds/android/<abi>/share/cmake/Realm/RealmConfig.cmake` | Acquires OpenSSL 3.5.9 instead of 3.3.1 | Same |
| `prebuilds/android/<abi>/share/cmake/Realm/AcquireRealmDependency.cmake` | Uses the bundled archive, downloads only as a fallback; the SHA-256 of the bundled archive is written into the file at build time, and CMake checks it with `file(SHA256)` before using the archive (a mismatch stops the build with `FATAL_ERROR`); the extraction folder includes the version (`openssl-3.5.9`) | Same, a damaged archive is never used, and a build folder left by upstream (OpenSSL 3.3.1) is never reused |
| `binding.gyp` | Removed | It only rebuilds the Node binary from source; npm would otherwise run node-gyp at install |
| `README.md` | Replaced, with a « Modified by Pomwik (Firas Hmedi), 2026 » note | Describes this package |
| `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, `CHANGES-FROM-UPSTREAM.md`, `checksums.txt` | Added (the upstream tarball has no LICENSE file). `THIRD-PARTY-NOTICES.md` lists the third-party code inside the prebuilt realm-core engine and the Node binaries, with its licence texts | Licence and traceability |
| `RealmJS.podspec`, `binding/android` | Not renamed, on purpose: the iOS pod `RealmJS`, the Android namespace `io.realm.react` and the native library `librealm.so` keep their upstream names. The pod version follows the package version (20.3.0, not an upstream release) | Drop-in compatibility: React Native autolinking, existing Podfiles and lockfiles, and the native code that looks up `io.realm.react` classes by name keep working unchanged |

## @pomwik/afterdb-react 0.20.1 (from @realm/react@0.20.0)

| File | Change | Why |
|---|---|---|
| `package.json` | `name` and `version` | New package |
| `package.json` | `description`, `homepage`, `repository`, `bugs` (upstream: the realm/realm-js issues) and `author` replaced, as in `@pomwik/afterdb` | Same |
| `package.json` | `react-native` moved from `optionalDependencies` to an optional peer dependency; the `realm` peer range (`>=20.0.0`) is unchanged, and `@pomwik/afterdb` satisfies it through the `realm` npm alias | A nested copy of react-native broke Android builds (realm/realm-js#7066) |
| `package.json` | `files`: `NOTICE` and `CHANGES-FROM-UPSTREAM.md` added (`LICENSE` was already listed upstream, once) | The added files ship in the package |
| `package.json` | `afterdb` field added | Marks the file as modified, and records where it comes from |
| `README.md` | Replaced, with a « Modified by Pomwik (Firas Hmedi), 2026 » note | Describes this package |
| `LICENSE`, `NOTICE`, `CHANGES-FROM-UPSTREAM.md` | Added (the upstream tarball has no LICENSE file). This `NOTICE` has no OpenSSL paragraph: the package ships no OpenSSL | Licence and traceability |

## Credits

- TPXP: the podspec fix for React Native >= 0.86 (realm/realm-js#7157).
- MongoDB, Inc. and the Realm JS contributors: everything else (Apache-2.0).
