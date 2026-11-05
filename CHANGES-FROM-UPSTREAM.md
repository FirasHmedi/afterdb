# Changes from upstream

`@pomwik/keelstore` (placeholder name) repackages the official npm tarballs `realm@20.2.0` and `@realm/react@0.20.0`
(Apache-2.0). The prebuilt realm-core engine is not recompiled or changed.
Every file listed here was modified; text files carry a « Modified by Pomwik, 2026 » comment.

## @pomwik/keelstore 20.3.0 (from realm@20.2.0)

| File | Change | Why |
|---|---|---|
| `package.json` | New name and version; `install` and `postinstall` scripts removed; `prebuild-install` and `node-machine-id` dependencies removed; `binary` field removed; `gypfile: false` | No download and no analytics at install time (realm/realm-js#7119, #7068, #7126) |
| `dist/scripts/submit-analytics.*`, `scripts/submit-analytics.js` | Removed | Install-time analytics |
| `prebuilds/node/<platform>-<arch>/realm.node` | Added: the upstream N-API binaries for darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64 | Installs work offline and in CI |
| `dist/platform/node/binding.js` | Loads the binary of the current platform, falls back to the upstream path | Same |
| `RealmJS.podspec` | `install_modules_dependencies(s)` instead of `s.dependency 'React'` | iOS linking on React Native >= 0.86 with frameworks (realm/realm-js#7157, fix by TPXP, reused with credit) |
| `RealmJS.podspec` | `REALM_ENABLE_SYNC=1` removed from the preprocessor flags | v20 has no sync; no shipped header or binding source reads it |
| `prebuilds/apple/realm-core.xcframework/*/Headers/external/s2/base/macros.h` | `DECLARE_POD` and `PROPAGATE_POD_FROM_TEMPLATE_ARGUMENT` no longer specialize `std::is_pod` | Build error on Xcode 26.4 (realm/realm-js#7115) |
| `prebuilds/android/<abi>/deps/openssl-3.3.1-*.tar.gz` | Added: the upstream OpenSSL archives | The Android build no longer downloads anything |
| `prebuilds/android/<abi>/share/cmake/Realm/AcquireRealmDependency.cmake` | Uses the bundled archive, downloads only as a fallback | Same |
| `binding.gyp` | Removed | It only rebuilds the Node binary from source; npm would otherwise run node-gyp at install |
| `README.md`, `LICENSE`, `NOTICE`, `CHANGES-FROM-UPSTREAM.md`, `checksums.txt` | Replaced or added (the upstream tarball has no LICENSE file) | Licence and traceability |

## @pomwik/keelstore-react 0.20.1 (from @realm/react@0.20.0)

| File | Change | Why |
|---|---|---|
| `package.json` | New name and version; `react-native` moved from `optionalDependencies` to an optional peer dependency; peer `realm` accepts keelstore versions | A nested copy of react-native broke Android builds (realm/realm-js#7066) |
| `README.md`, `LICENSE`, `NOTICE`, `CHANGES-FROM-UPSTREAM.md` | Replaced or added | Licence and traceability |

## Credits

- TPXP: the podspec fix for React Native >= 0.86 (realm/realm-js#7157).
- MongoDB, Inc. and the Realm JS contributors: everything else (Apache-2.0).
