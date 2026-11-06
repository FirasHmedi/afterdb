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

- From realm 20.2.0: same engine and same file format, so your `.realm` files open as they are. Files written by
  each were read by the other, both ways, plain and encrypted, in the independent review (Node, 2026-11-06).
- From an older realm (for example 12.x): not tested. Remove any sync code first, then try on a copy of the app's
  data, not on real users. Opening a file with v20 may upgrade its format, and after that an older realm version
  can no longer open it.
- Keep a backup of the `.realm` files before the first launch with the new package.

## Going back

To go back to realm 20.2.0, restore the original two lines and reinstall: same engine and file format, verified both
ways by the independent review on Node. Going back to a realm version older than 20 is not possible for a file that
v20 has already upgraded: restore the backup instead.
