#!/usr/bin/env node
// Reads the self-check result that the example app writes to selfcheck-result.realm, and checks it.
// Usage (from an app folder whose node_modules/realm is the afterdb package):
//   node ../scripts/read-selfcheck.mjs <selfcheck-result.realm> [expected launches]
// Prints the result as JSON. Exit code: 0 if the text is AFTERDB_SELF_CHECK_OK (and launches match),
// 1 otherwise, 2 if the file cannot be read.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [file, expectedLaunches] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/read-selfcheck.mjs <selfcheck-result.realm> [expected launches]');
  process.exit(2);
}
const require = createRequire(join(process.cwd(), 'package.json'));
const Realm = require('realm');
// Work on a copy: the app's folder is left untouched
const copy = join(mkdtempSync(join(tmpdir(), 'selfcheck-')), 'result.realm');
let row;
try {
  copyFileSync(file, copy);
  const realm = await Realm.open({ path: copy });
  const r = realm.objectForPrimaryKey('SelfCheckResult', 'last');
  row = r && { text: r.text, launches: r.launches, at: r.at.toISOString() };
  realm.close();
} catch (e) {
  console.error(`Cannot read ${file}: ${e.message}`);
  process.exit(2);
}
console.log(JSON.stringify(row ?? null));
const ok = row?.text === 'AFTERDB_SELF_CHECK_OK' && (!expectedLaunches || row.launches === `launches: ${expectedLaunches}`);
process.exit(ok ? 0 : 1);
