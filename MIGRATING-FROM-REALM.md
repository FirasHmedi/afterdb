# Switching from realm to @pomwik/keelstore

1. In `package.json`, point the two packages at the keelstore builds (your imports do not change):
   ```json
   "realm": "npm:@pomwik/keelstore@20.3.0",
   "@realm/react": "npm:@pomwik/keelstore-react@0.20.1"
   ```
2. Reinstall: `rm -rf node_modules && npm install` (or the yarn / pnpm equivalent).
3. iOS: `cd ios && pod install`. Android: `cd android && ./gradlew clean`.
4. Expo (dev build): `npx expo prebuild --clean`.

Your `.realm` files are not touched: it is the same engine and the same file format as realm 20.2.0.
Coming from realm 12.x without sync: v20 opens the same files; remove any sync code first.
To go back: restore the original two lines and reinstall.
