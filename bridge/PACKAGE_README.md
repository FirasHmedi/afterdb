# @pomwik/afterdb

An independent, maintained fork of the open-source Realm® JavaScript SDK v20 (realm-js, Apache-2.0; local database,
no sync), with build fixes for current React Native and Xcode.
Drop-in: your code keeps `import Realm from "realm"`.

```json
"dependencies": {
  "realm": "npm:@pomwik/afterdb@20.3.0",
  "@realm/react": "npm:@pomwik/afterdb-react@0.20.1"
}
```

What changes compared with realm@20.2.0: see CHANGES-FROM-UPSTREAM.md. In short: nothing is downloaded at install
time or during the Android build (the Node binaries and OpenSSL 3.5.9 LTS ship in the package), there is no
install-time analytics, the podspec uses React Native's own pod dependencies (realm/realm-js#7157), and the s2 headers
no longer specialize `std::is_pod` (realm/realm-js#7115). The realm-core engine is the upstream prebuilt one,
unchanged.

## Tested

- Android, React Native 0.88.1: release builds for the 4 ABIs; the app runs on Android 7, 11 and 16 emulators,
  including one with 16 KB memory pages.
- iOS, React Native 0.88.1, Xcode 26.6: on the simulator, with static frameworks, dynamic frameworks and no
  frameworks, the app runs and keeps its data after a restart. Device builds succeed (without code signing).
- Node 22 (macOS arm64, Linux x64): offline install, open, write, query, encrypted realm.

Being tested, not confirmed yet: React Native 0.86 and 0.87, Expo, Xcode 26.4.

Not supported: Device Sync, the old React Native architecture, bugs inside realm-core.

Realm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB.
Licence: Apache-2.0 (see LICENSE and NOTICE).

Modified by Pomwik, 2026: this file replaces the upstream README (see CHANGES-FROM-UPSTREAM.md).
