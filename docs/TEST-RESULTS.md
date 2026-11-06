# Test results

Local machine: macOS 14, Apple silicon, Node 22.19, Android SDK 36/37, NDK 27–28, Gradle 9.4.1. Xcode 26 needs
macOS 15, so iOS is tested only in CI (GitHub Actions, macOS runners); the Android builds and emulator runs marked CI
use ubuntu-24.04 runners. Each section says whether it ran locally or in CI.
afterdb was formerly keelstore: the first runs used the old package names and self-check marker, given here under
the new ones (`@pomwik/afterdb`, `@pomwik/afterdb-react`, `AFTERDB_SELF_CHECK_OK`). The converter keeps its current
names: the `keel-convert` command and the `_keel_meta` table.

## 2026-11-06

### Upstream realm@20.2.0, as published (inventory, phase 0)
- `npm install realm@20.2.0` runs `prebuild-install` (downloads the Node binary from static.realm.io) and then
  `postinstall` → `submit-analytics.js`, which throws an error (`getRealmCoreVersion`) in a plain Node project.
- The Android build downloads OpenSSL 3.3.1 from static.realm.io during CMake configure (seen in the Gradle log).
- iOS failures (#7157 on React Native >= 0.86, #7115 on Xcode 26.4): not reproduced locally (no Xcode 26 here).

### afterdb packages (`npm test`, 11 tests)
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
- `npm install`: `realm` and `@realm/react` resolve to `@pomwik/afterdb` and `@pomwik/afterdb-react`.
- `./gradlew assembleRelease` for arm64-v8a and x86_64: **BUILD SUCCESSFUL**. `librealm.so` built for both ABIs
  (9.4 MB and 10.3 MB). OpenSSL taken from the bundled archive, nothing downloaded from static.realm.io.
- 16 KB check (`scripts/check-16kb.mjs`, local; later also run in CI): **all 24 native libraries of the APK are
  16 KB aligned**.
- Run on the Pixel 8 emulator (Android 16, arm64): the self-check screen shows `AFTERDB_SELF_CHECK_OK` and
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
  shows `AFTERDB_SELF_CHECK_OK`, encrypted realm and live query included.

Found on the way: a `package-lock.json` pins the integrity of a local `.tgz`, so npm silently reinstalls the old
package after a rebuild. The example app no longer commits its lockfile.

### 16 KB checker (`node --test scripts/check-16kb.test.mjs`, 11 tests)
Pass, with `.so` files built by the NDK 28 clang (`-Wl,-z,max-page-size=4096` and `16384`, aarch64 and armv7a):
64-bit 4 KB fails, 64-bit 16 KB passes, 32-bit 4 KB is reported only (failed with `--all`), 32/64 bits read from the
ELF class even in a misplaced folder, non-ELF and truncated files skipped, empty folder and zip without `.so` exit 2,
`zipalign -c -P 16` run on an APK (fails on a stored, unaligned `.so`, passes after `zipalign -P 16`).
On the example APK: 24/24 64-bit libraries aligned, `zipalign -c -P 16 -v 4` OK.

## Independent review (2026-11-06)

An independent review tested the packages against upstream, with its own tests (`review/`):
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

Known and left as is: `librealm.so` contains source paths of the machine that builds the app (`__FILE__` in
assertion messages of the binding, compiled from `node_modules` at app build time; 11 in one arm64 build here).
Upstream `realm` does the same; nothing from our package is involved.

## iOS (GitHub Actions, macOS runners)

The local machine cannot run Xcode 26 (it runs macOS 14), so iOS is tested only in CI.

- Run 42211547552 (commit 5e666db): `pod install` installs `RealmJS (20.3.0)`, Debug simulator builds succeed with
  `USE_FRAMEWORKS=static` and `dynamic` (Xcode 26.6). This is the configuration that breaks upstream
  (realm/realm-js#7157, #7115).
- Run 42213034132 (commit 8de7841, first version of the self-check): for frameworks none, static and dynamic,
  Release build for an iPhone 17 Pro simulator (iOS 26.5, Xcode 26.6), the app launched twice; the result read
  from the app's own realm file:
  `launch 1: {"text":"…_SELF_CHECK_OK","launches":"launches: 1"}` and `launch 2: … "launches: 2"`
  (data kept after a restart). Release build for a generic iOS device without signing: arm64; with dynamic
  frameworks the app embeds `RealmJS.framework`.
- Run 42288300426 (commit de9a5ef: final names, app `AfterdbExample`, the 13-check self-check): frameworks none
  with **Xcode 26.4.1** (iPhone 17 Pro simulator, iOS 26.4) and dynamic frameworks with Xcode 26.6 (iOS 26.5):
  Debug and Release simulator builds succeed; the app launched twice:
  `launch 1: {"text":"AFTERDB_SELF_CHECK_OK","launches":"launches: 1"}`, `launch 2: … "launches: 2"`;
  device build arm64 (with dynamic frameworks the app embeds `RealmJS.framework`).

## Android emulators (GitHub Actions)

Run 42213034132: the release APK of the example launched twice on x86_64 emulators, each time
`…_SELF_CHECK_OK`, then `launches: 1` and `launches: 2`, no FATAL in logcat:
Android 7 (API 24, the minimum), Android 11 (API 30), Android 16 (API 36) and Android 16 with 16 KB pages
(`google_apis_ps16k`).
Run 42288300426 (final names, 13-check self-check): the same four emulators, same result; the Expo SDK 58 example
on Android 16 too. In the same run: typecheck of both examples, Debug build of the example (4 ABIs), release
builds with OpenSSL 3.5.9 checked for each ABI, 16 KB alignment 24/24 (example) and 34/34 (Expo), zipalign OK.

## React Native and Expo versions (local, Android)

Same self-check app (13 checks: create, primitives, link, list, embedded object, backlink, queries, update,
delete, encrypted realm reopened with its key and refused without it, live `useQuery` and `useObject`), release
build, run twice on the Pixel 8 emulator with 16 KB pages (`PAGE_SIZE` 16384): every run shows the OK marker,
`launches: 1` then `launches: 2`, and no FATAL line. Every 64-bit library is 16 KB aligned. In the first runs, the
OpenSSL in the CMake build folder was byte-identical to the package's (3.5.9).

| App | React Native | React | Install | Notes |
|---|---|---|---|---|
| bare example | 0.88.1 | 19.3.0 | `file:` tarballs | Debug and Release builds, 4 ABIs; also with R8 on (`enableProguardInReleaseBuilds`) |
| bare app (CLI init) | 0.87.1 | 19.2.3 | first run: npm alias from a local registry; rerun: `file:` tarballs | AGP 9.2.1, Gradle 9.4.1; first run before the NDK fix (`librealm.so` built with AGP's default NDK 28.2); rerun with the current packages, see below |
| bare app (CLI init) | 0.86.3 | 19.2.3 | first run: npm alias from a local registry; rerun: `file:` tarballs | AGP 8.12.0, Gradle 9.3.1; first run before the NDK fix (`librealm.so` built with AGP's default NDK 27.0); rerun with the current packages, see below |
| Expo SDK 58 (`examples/expo-58`) | 0.88.1 | 19.3.0 | `file:` tarballs; alias install resolves the same 488 packages | R8 on by default; no ProGuard rule in the app |
| Expo SDK 57 | 0.86.3 | 19.2.3 | `file:` tarballs | |
| Expo SDK 56 | 0.85.3 | 19.2.3 | `file:` tarballs | older than React Native 0.86, the lowest version targeted; still works |

**React Native 0.86.3 and 0.87.1 rerun with the current packages** (`@pomwik/afterdb` 20.3.0 and
`@pomwik/afterdb-react` 0.20.1, after the NDK fix and the consumer ProGuard rules): `npm install`, `npx tsc --noEmit`
and `assembleRelease` (arm64-v8a, x86_64) pass for both apps. `librealm.so` is built with the app's NDK
(`ndkVersion` 27.1.12297006, read from the CMake cache of each ABI). 24/24 64-bit libraries are 16 KB aligned and
`zipalign -P 16` passes. On the 16 KB emulator (Android 16), both launches show `AFTERDB_SELF_CHECK_OK`, with no FATAL
line. Not covered by this rerun: R8 (these templates leave minify off; the realm module's merged consumer rules do
contain the keep rule), and an app whose `ndkVersion` differs from React Native's default (27.1.12297006 here).

**Bug found and fixed with the Expo 58 example.** Expo SDK 58 turns R8 on for release builds. The upstream
Android library ships no consumer ProGuard rules, so R8 removed `io.realm.react.util.SSLHelper`, which only native
code looks up (`FindClass` in `JNI_OnLoad`), and the app crashed at start with `ClassNotFoundException`. Any app
that enables minification in release has the same problem. The package now ships
`binding/android/consumer-rules.pro` (`-keep class io.realm.react.** { *; }`): checked with the bare example
with R8 on and with Expo 58 without any rule in the app (R8 `configuration.txt` includes the rule, `mapping.txt`
keeps `SSLHelper`, the app runs).

## Adoption through the npm alias

The two README lines (`"realm": "npm:@pomwik/afterdb@20.3.0"`, `"@realm/react": "npm:@pomwik/afterdb-react@0.20.1"`)
were installed from a local registry (verdaccio, the packages were never published) with npm 10.9.3, yarn
1.22.22 and pnpm 10.34.9: `node_modules/realm` is our package, the Node binary loads, open/write/query and the
encrypted realm work, nothing is fetched from static.realm.io and no install script runs. The first React Native
0.86.3 and 0.87.1 runs above were installed this way (their rerun used `file:` tarballs). yarn 1 does not install
the `react` peer by itself (React Native apps always have it).

## realm-js's own test suites

Run against upstream `realm@20.2.0` and against our package, same harness, macOS arm64, Node 22.19 (realm-js
commit cf86fe01, the npm `gitHead` of 20.2.0; the `v20.2.0` tag points elsewhere):
- Node integration tests: 645 tests, identical results test by test. 612 pass, 0 fail, 33 pending for both, in 3
  paired runs. The harness entry leaves out the analytics tests (they test the analytics script we removed, and
  fail upstream too outside the monorepo).
- `@realm/react` jest tests: same results in 35 of 36 runs (one run froze under machine load). 75 pass, 3 skipped
  (skipped in the source), in 36 of 36 upstream runs and 35 of 36 runs with our package; in the other run, three
  test files froze together for 150 s while the machine was under heavy load, and this did not happen again.
- Not run: realm-js unit tests on the TypeScript source (they need a from-source build), the Electron and React
  Native test environments.

## Package hygiene audit

An audit of both tarballs against upstream found the packaging clean (every changed file documented, no install
script, no local path or secret in anything we built, LICENSE and NOTICE present, engine unchanged except the
documented header fix) and these problems, all fixed: upstream author (MongoDB) and bug URL left in our
package.json files, a shipped README claiming more than was proven, the local account name in the OpenSSL archives
(now 0:0), no checksum check of the bundled OpenSSL during the Android build (now SHA-256 checked by CMake), iOS
minimum version 9.0 in the podspec, `librealm.so` built with AGP's NDK instead of the app's.

### Not run yet
- Real devices (an iPhone, an Android phone): only simulators and emulators.
- iOS for the Expo example; iOS with React Native 0.86 and 0.87.
- The Node binaries for Windows, macOS x64 and Linux arm64 are byte-identical to upstream but were not executed
  (macOS arm64 runs locally, Linux x64 in CI with `npm test`).
