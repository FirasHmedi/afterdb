#!/usr/bin/env node
// Prints the text that the upgrade mode of the example app (example/upgrade/UpgradeApp.tsx) wrote to
// upgrade-result.realm, or nothing if there is none yet.
// Usage (from an app folder whose node_modules/realm can open realm files):
//   node ../scripts/read-upgrade-result.mjs <upgrade-result.realm>
// Exit code: 0 if a text was read, 2 if the file cannot be read.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/read-upgrade-result.mjs <upgrade-result.realm>');
  process.exit(2);
}
const require = createRequire(join(process.cwd(), 'package.json'));
const Realm = require('realm');
// Work on a copy: the app's folder is left untouched
const copy = join(mkdtempSync(join(tmpdir(), 'upgrade-result-')), 'result.realm');
try {
  copyFileSync(file, copy);
  const realm = await Realm.open({ path: copy });
  const row = realm.objectForPrimaryKey('UpgradeResult', 'last');
  console.log(row ? row.text : '');
  realm.close();
} catch (e) {
  console.error(`Cannot read ${file}: ${e.message}`);
  process.exit(2);
}
process.exit(0);
