# Switching from realm to @pomwik/afterdb

1. In `package.json`, point the two packages at the afterdb builds (your imports do not change):
   ```json
   "realm": "npm:@pomwik/afterdb@20.3.0",
   "@realm/react": "npm:@pomwik/afterdb-react@0.20.1"
   ```
2. Reinstall: `rm -rf node_modules && npm install` (or the yarn / pnpm equivalent).
3. iOS: `cd ios && pod install`. Android: `cd android && ./gradlew clean`.
4. Expo (dev build): `npx expo prebuild --clean`.

## Your data

- From realm 20.2.0: afterdb ships the same prebuilt engine, so the file format is the same. In Node, files written
  by each package were read by the other, both ways, plain and encrypted (independent review, 2026-11-06). There,
  both packages load the same binary: afterdb's `realm.node` is byte-identical to upstream's (SHA-256 compared for
  the 5 platforms afterdb ships).
- In an app, both ways, plain and encrypted: tested in CI on Android emulators and the iPhone simulator (Release
  builds; the `Upgrade` workflow, runs 42933195358 and 43000910682): the app on realm@20.2.0 writes, afterdb is
  installed over it and reads and writes, then realm@20.2.0 reads everything again. On Android the engine encrypts
  files with OpenSSL, which is 3.5.9 in afterdb instead of 3.3.1 upstream. Not tested on real devices: try it first
  on a copy of your app's data.
- From an older realm (for example 12.x): not tested. Remove any sync code first, then try on a copy of the app's
  data, not on real users. Opening a file with v20 may upgrade its format, and after that an older realm version
  can no longer open it.
- Keep a backup of the `.realm` files before the first launch with the new package.

## Going back

To go back to realm 20.2.0, restore the original two lines and reinstall. The engine and file format are the same;
realm 20.2.0 reading files written by afterdb was checked in Node only (see above), not on Android or iOS. Going
back to a realm version older than 20 is not possible for a file that v20 has already upgraded: restore the backup
instead.
