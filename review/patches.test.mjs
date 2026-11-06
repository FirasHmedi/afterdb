// Compares bridge/out/work/package with the upstream realm@20.2.0 tarball (bridge/.cache) and checks that ONLY the
// documented files differ; checks a podspec interaction with React Native's install_modules_dependencies.
// Run after `npm run build`: node --test review/patches.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'bridge/out/work/package');
const up = mkdtempSync(join(tmpdir(), 'review-up-'));
execFileSync('tar', ['-xzf', join(root, 'bridge/.cache/realm-20.2.0.tgz'), '-C', up]);
const upPkg = join(up, 'package');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const SLICES = ['ios-arm64', 'ios-arm64_x86_64-maccatalyst', 'ios-arm64_x86_64-simulator'];
const DOCUMENTED_CHANGED = new Set([
  'package.json', 'README.md', 'RealmJS.podspec', 'dist/platform/node/binding.js', 'binding/android/build.gradle',
  ...ABIS.flatMap((a) => [`prebuilds/android/${a}/share/cmake/Realm/RealmConfig.cmake`, `prebuilds/android/${a}/share/cmake/Realm/AcquireRealmDependency.cmake`]),
  ...SLICES.map((s) => `prebuilds/apple/realm-core.xcframework/${s}/Headers/external/s2/base/macros.h`),
]);
const DOCUMENTED_REMOVED = new Set(['binding.gyp', 'scripts/submit-analytics.js', 'dist/scripts/submit-analytics.js', 'dist/scripts/submit-analytics.js.map', 'dist/scripts/submit-analytics.d.ts']);
const DOCUMENTED_ADDED = (f) => /^prebuilds\/node\/(darwin-arm64|darwin-x64|linux-x64|linux-arm64|win32-x64)\/realm\.node$/.test(f) || /^prebuilds\/android\/[^/]+\/deps\/openssl-3\.5\.9-[a-z0-9]+-android\.tar\.gz$/.test(f) || ['LICENSE', 'NOTICE', 'CHANGES-FROM-UPSTREAM.md', 'checksums.txt', 'binding/android/consumer-rules.pro'].includes(f);

test('only the documented files are changed, removed or added', () => {
  const a = new Set(walk(upPkg).map((f) => relative(upPkg, f)));
  const b = new Set(walk(pkg).map((f) => relative(pkg, f)));
  const removed = [...a].filter((f) => !b.has(f));
  const added = [...b].filter((f) => !a.has(f));
  const changed = [...a].filter((f) => b.has(f) && !readFileSync(join(upPkg, f)).equals(readFileSync(join(pkg, f))));
  assert.deepEqual(removed.filter((f) => !DOCUMENTED_REMOVED.has(f)), []);
  assert.deepEqual(added.filter((f) => !DOCUMENTED_ADDED(f)), []);
  assert.deepEqual(changed.filter((f) => !DOCUMENTED_CHANGED.has(f)).sort(), []);
  assert.equal(changed.length, DOCUMENTED_CHANGED.size, 'a documented patch silently did not apply');
});

test('every changed text file carries the « Modified by Pomwik » notice (Apache-2.0 §4(b)); package.json via its "afterdb" field', () => {
  for (const f of DOCUMENTED_CHANGED) {
    if (f === 'README.md') continue; // replaced
    const t = readFileSync(join(pkg, f), 'utf8');
    if (f === 'package.json') assert.ok(JSON.parse(t).afterdb?.upstream);
    else assert.match(t, /Modified by Pomwik, 2026/, f);
  }
});

// Updated on 2026-11-06: HEADER_SEARCH_PATHS is now a string, so React Native's concatenation gives valid paths.
test('podspec: HEADER_SEARCH_PATHS is a string, so install_modules_dependencies keeps it valid', { skip: spawnSync('ruby', ['-v']).status !== 0 }, () => {
  const rn = join(root, 'example/node_modules/react-native/scripts/cocoapods/new_architecture.rb');
  if (existsSync(rn)) assert.match(readFileSync(rn, 'utf8'), /"#\{current_headers\} #\{header_search_paths_string\}"/);
  const spec = readFileSync(join(pkg, 'RealmJS.podspec'), 'utf8');
  assert.doesNotMatch(spec, /'HEADER_SEARCH_PATHS' => \[/);
  const m = spec.match(/'HEADER_SEARCH_PATHS' => '([^']*)'/);
  assert.ok(m, 'HEADER_SEARCH_PATHS string not found');
  // Same expression as React Native 0.88.1 new_architecture.rb:109-111 with the podspec's value
  const out = execFileSync('ruby', ['-e', 'h=ARGV[0]; s=%q("$(PODS_ROOT)/Headers/Private/Yoga"); print(h.empty? ? s : "#{h} #{s}")', m[1]], { encoding: 'utf8' });
  console.log('resulting HEADER_SEARCH_PATHS:', out);
  assert.equal(out, '"${PODS_TARGET_SRCROOT}/bindgen/vendor/realm-core/bindgen/src/" "$(PODS_ROOT)/Headers/Private/Yoga"');
});

// Updated on 2026-11-06: the dead "#realm.node" import is removed (binding.js no longer uses it).
test('package.json: no "imports" field left (its only entry, "#realm.node", is removed)', () => {
  const pj = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.equal(pj.imports, undefined);
});

test('package size vs upstream', () => {
  const kb = (d) => Number(execFileSync('du', ['-sk', d], { encoding: 'utf8' }).split('\t')[0]);
  console.log(`unpacked: upstream ${Math.round(kb(upPkg) / 1024)} MB, afterdb ${Math.round(kb(pkg) / 1024)} MB; tarball upstream ${Math.round(statSync(join(root, 'bridge/.cache/realm-20.2.0.tgz')).size / 1048576)} MB, afterdb ${Math.round(statSync(join(root, 'bridge/out/pomwik-afterdb-20.3.0.tgz')).size / 1048576)} MB`);
});

// Updated on 2026-11-06: every upstream download is now checked against a pinned hash, on download and on reuse.
test('supply chain: npm tarballs, Node binaries, OpenSSL source and the upstream OpenSSL archive are pinned', () => {
  const b = readFileSync(join(root, 'bridge/build.mjs'), 'utf8');
  const sh = readFileSync(join(root, 'bridge/openssl/build-openssl.sh'), 'utf8');
  assert.doesNotMatch(b, /if \(existsSync\(file\)\) return readFileSync\(file\)/, 'cache files trusted as is');
  assert.match(b, /NODE_SHA256/);
  assert.equal((b.match(/['"][0-9a-f]{64}['"]/g) ?? []).length >= 5, true, 'expected 5 pinned SHA-256 for the Node binaries');
  assert.match(sh, /3\.5\.9\) PINNED=[0-9a-f]{64}/);
  assert.match(sh, /UPSTREAM_ARM64_SHA=[0-9a-f]{64}/);
  // Not done, documented: no GPG check of the OpenSSL release; the pinned SHA-256 was compared with the published one.
});
