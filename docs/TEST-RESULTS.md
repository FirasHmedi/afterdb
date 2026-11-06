# Test results

Machine: MacBook (macOS 14.4, Apple silicon), Node 22.19, Android SDK 36/37, NDK 27–28, Gradle 9.4.1.
Xcode is not installed on this machine (Xcode 26 needs macOS 15): iOS is only configured in CI.
Results are local unless marked CI. The CI (GitHub Actions, ubuntu-24.04) had its first green run on 2026-11-06
(packages, tests, Android build of the 4 ABIs, 16 KB check). The iOS job is configured but has not run yet.

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
- 16 KB check (`scripts/check-16kb.mjs`, local; configured in CI): **all 24 native libraries of the APK are 16 KB
  aligned**.
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

### 16 KB checker (`node --test scripts/check-16kb.test.mjs`, 11 tests)
Pass, with `.so` files built by the NDK 28 clang (`-Wl,-z,max-page-size=4096` and `16384`, aarch64 and armv7a):
64-bit 4 KB fails, 64-bit 16 KB passes, 32-bit 4 KB is reported only (failed with `--all`), 32/64 bits read from the
ELF class even in a misplaced folder, non-ELF and truncated files skipped, empty folder and zip without `.so` exit 2,
`zipalign -c -P 16` run on an APK (fails on a stored, unaligned `.so`, passes after `zipalign -P 16`).
On the example APK: 24/24 64-bit libraries aligned, `zipalign -c -P 16 -v 4` OK.

## Independent review (2026-11-06)

A separate session tested the packages against upstream, with its own tests (`review/`):
- Node API behaviour identical to `realm@20.2.0`: BSON types, embedded objects, sets, dictionaries, mixed, counters,
  backlinks, migrations, listeners, compact, read-only and in-memory realms.
- Files written by each package are read by the other, both ways, plain and encrypted.
- The Node binary is byte-identical to the upstream one; only the files listed in `CHANGES-FROM-UPSTREAM.md` differ
  from the upstream tarball.
- Offline reinstall with an invalid proxy works. yarn 1 OK; pnpm not tested.
- Android build with an invalid proxy for CMake OK (nothing downloaded), and the self-check passes on the 16 KB
  emulator.

Defects found, all fixed the same day (the review tests that showed them now check the fix, `review/run-all.sh`):
- converter: silent loss of data with `--schema` (the model now always comes from the file; the app schema only
  adds backlinks and drift warnings); a failed verification left a file at the final path (now `<out>.failed`);
  `--force` deleted the old output first; clashing names (`Item`/`item`, `_keel_meta`) stopped the conversion
  (now renamed with a suffix, recorded in `_keel_meta`);
- CI: missing `pipefail`, so a failing step could pass;
- podspec: `HEADER_SEARCH_PATHS` given as an array, which `install_modules_dependencies` turns into `["..."] …`;
- upstream downloads not pinned (Node binaries, OpenSSL archives): now checked against pinned hashes, also on reuse;
- local build paths in the OpenSSL libraries (`--prefix`): now neutral, and the build stops if one appears.

Also found and fixed in `scripts/check-16kb.mjs`: 32/64 bits taken from the folder name, a crash on an APK without
`.so` and on a non-ELF file, no zip alignment check.

## After the fixes (2026-11-06)

- `npm test` 11/11; converter 15 pass, 1 skipped (16 tests); `scripts/check-16kb.test.mjs` 11/11; review tests
  patches 6/6, install 4/4, node-api 7/7, check16kb 6/6, converter-adversarial 13/13.
- OpenSSL rebuilt: no `/Users/` string in any of the 4 ABIs; embedded paths are `/etc/ssl` and `/usr/local/...`.
  ELF class and machine checked per ABI (AArch64, ARM, Intel 80386, X86-64).
- Android release build, 4 ABIs: OpenSSL in the build folder byte-identical to the package's, version 3.5.9;
  24/24 64-bit libraries 16 KB aligned, `zipalign -c -P 16 -v 4` OK.
- **Persistence on the 16 KB emulator** (Pixel 8, `PAGE_SIZE` = 16384): a launch counter in an on-disk realm shows
  `launches: 1`, then `launches: 2` after a force-stop and cold start; no crash in logcat.
- **CI** (push to `main`, commits 33d28c8 and 188ad2c): packages, tests, converter tests on our package, Android
  release build of the 4 ABIs, bundled OpenSSL 3.5.9 checked for each ABI, 16 KB check 24/24 and zipalign OK.

Known and left as is: `librealm.so` contains two source paths of the machine that builds the app (`__FILE__` in
assertion messages of the binding, compiled from `node_modules` at app build time). Upstream `realm` does the same.

### Not run yet
- iOS (Xcode 26.4, frameworks none / static / dynamic): configured in CI (job `ios`, started by hand on macOS
  runners), never run.
- React Native 0.86 and 0.87, Expo SDK 56–58.
