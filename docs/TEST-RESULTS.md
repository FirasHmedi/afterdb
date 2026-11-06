# Test results

Machine: MacBook (macOS 14.4, Apple silicon), Node 22.19, Android SDK 36/37, NDK 27–28, Gradle 9.4.1.
Xcode is not installed on this machine (Xcode 26 needs macOS 15): iOS runs only in the CI job.

## 2026-11-06

### Upstream realm@20.2.0, as published (inventory, phase 0)
- `npm install realm@20.2.0` runs `prebuild-install` (downloads the Node binary from static.realm.io) and then
  `postinstall` → `submit-analytics.js`, which throws an error (`getRealmCoreVersion`) in a plain Node project.
- The Android build downloads OpenSSL 3.3.1 from static.realm.io during CMake configure (seen in the Gradle log).
- iOS failures (#7157 on React Native >= 0.86, #7115 on Xcode 26.4): not reproduced locally (no Xcode 26 here).

### keelstore packages (`npm test`, 11 tests)
| Test | Result |
|---|---|
| package.json: no install/postinstall script, no prebuild-install, no analytics, no binding.gyp | Pass |
| LICENSE, NOTICE, CHANGES-FROM-UPSTREAM.md (credits), trademark notice | Pass |
| Node binaries for 5 platforms, loaded by platform | Pass |
| Podspec: `install_modules_dependencies(s)`, no `REALM_ENABLE_SYNC=1` | Pass |
| No shipped header specializes `std::is_pod`; patched s2 headers compile (clang, C++20) | Pass |
| OpenSSL bundled for 4 ABIs; the CMake script extracts it without any download (run with `cmake -P`) | Pass |
| Offline install under the name `realm`; open, write, query, encrypted realm, refused without the key (Node) | Pass |
| `@realm/react`: react-native is an optional peer, not a nested dependency | Pass |

### Example app, React Native 0.88.1, new architecture, Hermes (Android)
- `npm install`: `realm` and `@realm/react` resolve to `@pomwik/keelstore` and `@pomwik/keelstore-react`.
- `./gradlew assembleRelease` for arm64-v8a and x86_64: **BUILD SUCCESSFUL**. `librealm.so` built for both ABIs
  (9.4 MB and 10.3 MB). OpenSSL taken from the bundled archive, nothing downloaded from static.realm.io.
- 16 KB check (`scripts/check-16kb.mjs`): **all 24 native libraries of the APK are 16 KB aligned**.
- Run on the Pixel 8 emulator (Android 16, arm64): the self-check screen shows `KEELSTORE_SELF_CHECK_OK` and
  « 11 tasks done (live query) »: write, read, update and live query through `RealmProvider` / `useQuery`.

First attempt failed (`Could NOT find OpenSSL`): `file(COPY_FILE)` does not create the destination folder, unlike
the `file(DOWNLOAD)` it replaced, and `CMAKE_CURRENT_LIST_DIR` inside a function points at the caller. Both fixed,
and the `cmake -P` test now catches this class of error without an NDK.

### Converter (`cd converter && npm test`)
10 tests: 9 pass, 1 skipped (200 000 objects, run on demand). Figures in `converter/README.md`.

### OpenSSL 3.5.9 LTS and the 4 ABIs (later the same day)
- `bridge/openssl/build-openssl.sh 3.5.9`: source SHA-256 checked, 4 static builds in 1 min 40.
- `./gradlew assembleRelease` for arm64-v8a, armeabi-v7a, x86, x86_64: **BUILD SUCCESSFUL**; the CMake build dir
  holds `OPENSSL_VERSION_TEXT "OpenSSL 3.5.9 29 Sep 2026"`.
- 16 KB check: **all 24 libraries of the 64-bit ABIs are 16 KB aligned**. The 24 libraries of the 32-bit ABIs
  (React Native's own included) are 4 KB aligned, which Google Play allows: the check reports them only.
- Self-check extended with an encrypted realm (64-byte key: write, close, reopen with the key, refused without it).
- **Emulator with 16 KB pages** (Android 16, `google_apis_playstore_ps16k`, `PAGE_SIZE` = 16384): the app starts and
  shows `KEELSTORE_SELF_CHECK_OK`, encrypted realm and live query included.

Found on the way: a `package-lock.json` pins the integrity of a local `.tgz`, so npm silently reinstalls the old
package after a rebuild. The example app no longer commits its lockfile.

### Not run yet
- iOS (Xcode 26.4, frameworks none / static / dynamic): CI job `ios`, started by hand.
- React Native 0.86 and 0.87, Expo SDK 56–58.
