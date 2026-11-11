// Install the built tarball under the name "realm" in fresh projects (npm, then yarn 1), check that nothing runs at
// install and that a second install works with the network blocked (invalid proxy, npm --offline).
// Run after `npm run build`: node --test review/install.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tarball = join(root, 'bridge/out/pomwik-afterdb-20.3.1.tgz');
const BLOCKED = { ...process.env, https_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', npm_config_proxy: 'http://127.0.0.1:9', npm_config_https_proxy: 'http://127.0.0.1:9' };

function app(name) {
  const dir = mkdtempSync(join(tmpdir(), `review-${name}-`));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module', dependencies: { realm: `file:${tarball}` } }));
  return dir;
}
function scriptsOf(nm) {
  const found = [];
  const visit = (d) => {
    for (const e of readdirSync(d)) {
      if (e === '.bin' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (e.startsWith('@')) { visit(p); continue; }
      const pj = join(p, 'package.json');
      if (!existsSync(pj)) continue;
      const j = JSON.parse(readFileSync(pj, 'utf8'));
      for (const s of ['preinstall', 'install', 'postinstall']) if (j.scripts?.[s]) found.push(`${j.name}:${s}`);
      if (existsSync(join(p, 'binding.gyp')) && j.gypfile !== false) found.push(`${j.name}:binding.gyp`);
      if (existsSync(join(p, 'node_modules'))) visit(join(p, 'node_modules'));
    }
  };
  visit(nm);
  return found;
}

test('npm: --foreground-scripts shows no lifecycle script; no dependency has one', () => {
  const dir = app('npm');
  const r = spawnSync('npm', ['install', '--foreground-scripts', '--no-audit', '--no-fund', '--loglevel', 'verbose'], { cwd: dir, encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const log = r.stdout + r.stderr;
  assert.doesNotMatch(log, /> .*(preinstall|install|postinstall)\b.*\n/i, 'a lifecycle script ran');
  assert.doesNotMatch(log, /prebuild-install|submit-analytics|node-gyp|static\.realm\.io/);
  assert.deepEqual(scriptsOf(join(dir, 'node_modules')), []);
  const size = execFileSync('du', ['-sk', join(dir, 'node_modules/realm')], { encoding: 'utf8' }).split('\t')[0];
  console.log(`installed node_modules/realm: ${Math.round(size / 1024)} MB`);
});

test('npm: second install with the network blocked (invalid proxy + --offline) succeeds and works', () => {
  const dir = app('npm-offline');
  const r = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', env: BLOCKED, timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  writeFileSync(join(dir, 't.mjs'), "import Realm from 'realm'; const r = await Realm.open({ inMemory: true, path: 'm.realm', schema: [{ name: 'A', properties: { x: 'int' } }] }); r.write(() => r.create('A', { x: 1 })); console.log(r.objects('A').length); r.close(); process.exit(0);\n");
  assert.equal(execFileSync('node', ['t.mjs'], { cwd: dir, encoding: 'utf8', env: BLOCKED }).trim(), '1');
});

test('yarn 1: install, no lifecycle script, works', { skip: spawnSync('yarn', ['--version']).status !== 0 }, () => {
  const dir = app('yarn');
  const r = spawnSync('yarn', ['install', '--non-interactive', '--no-lockfile', '--verbose'], { cwd: dir, encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, (r.stderr ?? '').slice(-2000));
  const log = r.stdout + r.stderr;
  assert.doesNotMatch(log, /prebuild-install|submit-analytics|node-gyp rebuild|static\.realm\.io/);
  assert.doesNotMatch(log, /verbose.*Running .*(install|postinstall)/i);
  assert.equal(JSON.parse(readFileSync(join(dir, 'node_modules/realm/package.json'), 'utf8')).name, '@pomwik/afterdb');
  writeFileSync(join(dir, 't.mjs'), "import Realm from 'realm'; console.log(typeof Realm.open); process.exit(0);\n");
  assert.equal(execFileSync('node', ['t.mjs'], { cwd: dir, encoding: 'utf8' }).trim(), 'function');
});

// Updated on 2026-11-06: the dead "#realm.node" import is removed; binding.js names the platform when no binary
// is shipped for it.
test('binding: no "#realm.node" import left, and no binary at the upstream path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-pkg-'));
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  const pj = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'));
  assert.equal(pj.imports, undefined);
  assert.equal(existsSync(join(dir, 'package/prebuilds/node/realm.node')), false);
  const sizes = readdirSync(join(dir, 'package/prebuilds/node')).map((t) => `${t}=${Math.round(statSync(join(dir, 'package/prebuilds/node', t, 'realm.node')).size / 1048576)}MB`);
  console.log('node binaries:', sizes.join(' '), ' tarball:', Math.round(statSync(tarball).size / 1048576), 'MB');
});
