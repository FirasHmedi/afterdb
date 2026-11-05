# @pomwik/keelstore

Maintained build of the Realm JS SDK v20 (local database, no sync) for current React Native, Expo and Xcode.
Drop-in: your code keeps `import Realm from "realm"`.

```json
"dependencies": {
  "realm": "npm:@pomwik/keelstore@20.3.0",
  "@realm/react": "npm:@pomwik/keelstore-react@0.20.1"
}
```

What changes compared with realm@20.2.0: see CHANGES-FROM-UPSTREAM.md. Nothing is downloaded at install or build
time, there is no install-time analytics, iOS links on React Native 0.86+ and builds with Xcode 26.4.
The realm-core engine is the upstream prebuilt one, unchanged.

Not supported: Device Sync, the old React Native architecture, bugs inside realm-core.

Realm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB.
Licence: Apache-2.0 (see LICENSE and NOTICE).
