// Differential tests: the same scripts run on upstream realm@20.2.0 (converter/node_modules/realm, as installed by
// upstream's own install script) and on the built @pomwik/keelstore tarball installed as "realm".
// Run after `npm run build` and `cd converter && npm install`: node --test review/node-api.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tarball = join(root, 'bridge/out/pomwik-keelstore-20.3.0.tgz');
const upstreamNM = join(root, 'converter/node_modules');

function setup() {
  const keel = mkdtempSync(join(tmpdir(), 'review-keel-'));
  writeFileSync(join(keel, 'package.json'), JSON.stringify({ name: 'k', private: true, type: 'module', dependencies: { realm: `file:${tarball}` } }));
  execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: keel, stdio: 'pipe', timeout: 300_000 });
  const up = mkdtempSync(join(tmpdir(), 'review-up-'));
  writeFileSync(join(up, 'package.json'), JSON.stringify({ name: 'u', private: true, type: 'module' }));
  symlinkSync(upstreamNM, join(up, 'node_modules'));
  for (const d of [keel, up]) for (const f of ['probe.mjs', 'compat.mjs']) cpSync(join(here, 'fixtures', f), join(d, f));
  return { keel, up };
}
const { keel, up } = existsSync(join(upstreamNM, 'realm')) ? setup() : {};
const skip = !keel;
const run = (cwd, ...args) => {
  const r = spawnSync('node', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  return r.stdout.trim();
};

test('versions under test', { skip }, () => {
  const k = JSON.parse(readFileSync(join(keel, 'node_modules/realm/package.json'), 'utf8'));
  const u = JSON.parse(readFileSync(join(up, 'node_modules/realm/package.json'), 'utf8'));
  assert.equal(k.name, '@pomwik/keelstore');
  assert.equal(u.name, 'realm');
  assert.equal(u.version, '20.2.0');
});

test('same behaviour as upstream: types, migration, listeners, deleteFile, compact, read-only, in-memory', { skip }, () => {
  const a = JSON.parse(run(keel, 'probe.mjs', join(keel, 'files')));
  const b = JSON.parse(run(up, 'probe.mjs', join(up, 'files')));
  console.log(JSON.stringify(a));
  assert.deepEqual(a, b);
  for (const [k, v] of Object.entries(a)) assert.ok(!(v && v.error), `${k}: ${JSON.stringify(v)}`);
  assert.equal(a.migration.called, 1);
  assert.equal(a.migration.full, 'Ada L');
  assert.ok(a.listeners.events.length >= 3, JSON.stringify(a.listeners));
});

for (const key of [null, 'ab'.repeat(64)]) {
  const label = key ? 'encrypted' : 'plain';
  test(`file format: written by upstream 20.2.0, read by keelstore (${label})`, { skip }, () => {
    const f = join(up, `u-${label}.realm`);
    run(up, 'compat.mjs', 'write', f, ...(key ? [key] : []));
    const fromKeel = JSON.parse(run(keel, 'compat.mjs', 'read', f, ...(key ? [key] : [])));
    const fromUp = JSON.parse(run(up, 'compat.mjs', 'read', f, ...(key ? [key] : [])));
    assert.deepEqual(fromKeel, fromUp);
    assert.equal(fromKeel.n, 500);
  });
  test(`file format: written by keelstore, read by upstream 20.2.0 (${label})`, { skip }, () => {
    const f = join(keel, `k-${label}.realm`);
    run(keel, 'compat.mjs', 'write', f, ...(key ? [key] : []));
    const fromUp = JSON.parse(run(up, 'compat.mjs', 'read', f, ...(key ? [key] : [])));
    const fromKeel = JSON.parse(run(keel, 'compat.mjs', 'read', f, ...(key ? [key] : [])));
    assert.deepEqual(fromUp, fromKeel);
    assert.equal(fromUp.n, 500);
  });
}

test('the Node binary loaded is the bundled darwin/linux one, byte-identical to the upstream prebuild', { skip }, () => {
  const k = readFileSync(join(keel, `node_modules/realm/prebuilds/node/${process.platform}-${process.arch}/realm.node`));
  const u = readFileSync(join(up, 'node_modules/realm/prebuilds/node/realm.node'));
  assert.ok(k.equals(u), 'bundled binary differs from the one upstream install downloads');
});
