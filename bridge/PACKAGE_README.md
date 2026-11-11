# @pomwik/afterdb

An independent, maintained fork of the open-source Realm® JavaScript SDK v20 (realm-js, Apache-2.0; local database,
no sync), with build fixes for current React Native and Xcode.
Drop-in: your code keeps `import Realm from "realm"`.

```json
"dependencies": {
  "realm": "npm:@pomwik/afterdb@20.3.1",
  "@realm/react": "npm:@pomwik/afterdb-react@0.20.2"
}
```

What changes compared with realm@20.2.0: see CHANGES-FROM-UPSTREAM.md. In short: nothing is downloaded at install
time or during the Android build (the Node binaries and OpenSSL 3.5.9 LTS ship in the package), there is no
install-time analytics, the podspec uses React Native's own pod dependencies (realm/realm-js#7157), and the s2 headers
no longer specialize `std::is_pod` (realm/realm-js#7115). The realm-core engine is the upstream prebuilt one,
unchanged.

## Tested

- Android, React Native 0.88.1: Debug and release builds for the 4 ABIs; the app runs on Android 7, 11 and 16
  emulators, including one with 16 KB memory pages, and keeps its data after a restart.
- Android, React Native 0.86.3 and 0.87.1, and Expo SDK 56, 57 and 58: release builds run on an Android 16
  emulator with 16 KB pages (React Native 0.86.3 and 0.87.1 rerun with this package, `librealm.so` built with the
  app's NDK). Release builds with R8 (Expo 58's default) work: the package ships its keep rules.
- iOS, React Native 0.88.1, Xcode 26.4.1 and 26.6: on the simulator, the app runs and keeps its data after a
  restart (Xcode 26.6: static frameworks, dynamic frameworks and no frameworks; Xcode 26.4.1: no frameworks).
  Device builds succeed (without code signing).
- Node 22 (macOS arm64, Linux x64): offline install, open, write, query, encrypted realm.
- realm-js's own test suites, compared with realm@20.2.0 on macOS arm64 only: Node integration tests, 645 tests,
  identical results test by test; `@realm/react`: same results in 35 of 36 runs (one run froze under machine load).

Not tested yet: real devices, and iOS with React Native 0.86/0.87 or Expo.

Not supported: Device Sync, the old React Native architecture, bugs inside realm-core.

Realm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB.
Licence: Apache-2.0 (see LICENSE and NOTICE). The prebuilt realm-core engine contains third-party code under other
licences: see THIRD-PARTY-NOTICES.md.

Modified by Pomwik (Firas Hmedi), 2026: this file replaces the upstream README (see CHANGES-FROM-UPSTREAM.md).
