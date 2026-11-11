# afterdb example (React Native 0.88.1)

A bare React Native 0.88.1 app (new architecture, Hermes) that uses the afterdb packages under their usual names:
`import Realm from "realm"` and `@realm/react`. `package.json` points `realm` and `@realm/react` at the tarballs
built in this repository (`file:` paths), so the example works without a registry. In your own app, use the npm
aliases shown in the root `README.md`.

## The self-check

On start, the app runs a self-check on a Projects/Tasks model (`schema.ts`): create, read, update, delete,
primitives, link, list, embedded object, backlink, queries, an encrypted realm (64-byte key: reopened with the key,
refused without it), and the live hooks `useQuery` and `useObject` inside `RealmProvider`. The screen shows
`AFTERDB_SELF_CHECK_OK` when every check passes, otherwise `AFTERDB_SELF_CHECK_FAILED` and the names of the failed
checks. The app also counts its launches in a realm file kept on disk (`launches: 1`, then `launches: 2` after a
restart) and writes the result to `selfcheck-result.realm`.

`scripts/android-selfcheck.sh` and `scripts/ios-selfcheck.sh` (repository root) launch the release app twice and
check both launches: the CI runs them on Android emulators and iOS simulators.

## Build

Build the packages first, from the repository root (`npm run build`, see the root `README.md`). `package-lock.json`
is not committed: it would pin the integrity of the local `.tgz` files, and npm would keep an old package after a
rebuild.

Android (release APK for arm64-v8a and x86_64; `cd android && ./gradlew assembleRelease` builds the 4 ABIs):

```bash
cd example
npm install
npx tsc --noEmit
npm run build:android
node ../scripts/check-16kb.mjs android/app/build/outputs/apk/release/app-release.apk
# with an emulator or a device connected:
bash ../scripts/android-selfcheck.sh android/app/build/outputs/apk/release/app-release.apk com.afterdbexample selfcheck.png
```

iOS (Xcode 26.4 or later; set `USE_FRAMEWORKS=static` or `dynamic` before `pod install` to build with frameworks):

```bash
cd example
npm install
cd ios && bundle install && bundle exec pod install && cd ..
# SIM_UDID: a booted iPhone simulator (xcrun simctl list devices booted)
xcodebuild -workspace ios/AfterdbExample.xcworkspace -scheme AfterdbExample -configuration Release \
  -destination "id=$SIM_UDID" -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
bash ../scripts/ios-selfcheck.sh ios/build/Build/Products/Release-iphonesimulator/AfterdbExample.app \
  org.reactjs.native.example.AfterdbExample selfcheck.png
```

Debug builds load their JavaScript from Metro: `npm start`, then `npm run android` or `npm run ios`.

## Upgrade mode

`ENTRY_FILE=index.upgrade.js` at build time (read by React Native's Gradle plugin and by the Xcode bundle phase)
builds the upgrade test instead of the self-check (`upgrade/`). The workflow `.github/workflows/upgrade.yml` builds
it once with the official `realm@20.2.0` and `@realm/react@0.20.0` and once with afterdb, then installs one build
over the other on the same emulator or simulator (`scripts/android-upgrade.sh`, `scripts/ios-upgrade.sh`).

Each launch is one stage. It opens a plain file and an encrypted file (fixed 64-byte test key), checks every object
that earlier stages wrote (each field against the generator in `upgrade/data.ts`, and the SHA-256 recorded by the
stage that wrote it), then adds 120 objects that use every property type of realm-js v20 (primitives, optionals,
lists, sets, dictionaries, mixed with nested collections, counter, links, embedded objects, backlinks, a full-text
index). The screen shows `AFTERDB_UPGRADE_OK stage=<n> history=<package that wrote each stage> items=<count>`.

```bash
cd example/android
ENTRY_FILE=index.upgrade.js ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon
```

## Licence

`App.tsx`, `schema.ts`, `index.upgrade.js`, `upgrade/` and the self-check are under the Apache License 2.0 (`../LICENSE`). The files that come from
the React Native app template are under the MIT licence: see `LICENSE-template`.
