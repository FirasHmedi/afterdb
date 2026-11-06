// Tests of the built packages (run `npm run build` first). Usage: node --test bridge/test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ANDROID_ABIS, NAME, NODE_TARGETS, OPENSSL, VERSION } from '../build.mjs';
import { NAME as REACT_NAME, VERSION as REACT_VERSION } from '../../react/build.mjs';

/** Package metadata of both packages: final names, Pomwik as author, our repository (never MongoDB's) */
const REPO = 'https://github.com/FirasHmedi/afterdb';
function assertMetadata(pj) {
  assert.deepEqual(pj.author, { name: 'Pomwik', email: 'hello@pomwik.com', url: 'https://pomwik.com' });
  assert.equal(pj.homepage, REPO);
  assert.deepEqual(pj.repository, { type: 'git', url: `git+${REPO}.git` });
  assert.deepEqual(pj.bugs, { url: `${REPO}/issues` });
  assert.ok(pj.description.includes('Realm®'));
  assert.doesNotMatch(pj.description.slice(0, pj.description.indexOf('Realm®')), /realm/i, 'Realm® at the first mention');
  assert.match(pj.description, /Not affiliated with or endorsed by MongoDB, Inc\.$/);
  assert.ok(!pj.keywords.includes('mongodb'));
  assert.ok(pj.keywords.includes('realm'));
  assert.match(pj.afterdb.upstreamIntegrity, /^sha512-/);
  assert.equal(pj.keelstore, undefined);
  assert.equal(new Set(pj.files).size, pj.files.length, `duplicate in files: ${pj.files}`);
  assert.doesNotMatch(JSON.stringify(pj), /keelstore|help@realm\.io/);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = join(root, 'bridge/out/work/package');
// npm pack names a scoped package « scope-name-version.tgz »
const packed = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
const tarball = join(root, 'bridge/out', packed(NAME, VERSION));
const reactTarball = join(root, 'react/out', packed(REACT_NAME, REACT_VERSION));

test('final names: @pomwik/afterdb 20.3.0 and @pomwik/afterdb-react 0.20.1', () => {
  assert.equal(packed(NAME, VERSION), 'pomwik-afterdb-20.3.0.tgz');
  assert.equal(packed(REACT_NAME, REACT_VERSION), 'pomwik-afterdb-react-0.20.1.tgz');
});
const read = (f) => readFileSync(join(pkg, f), 'utf8');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test('the packages were built', () => {
  assert.ok(existsSync(tarball), `${tarball} missing: run npm run build`);
  assert.ok(existsSync(reactTarball), `${reactTarball} missing: run npm run build`);
});

test('package.json: no install-time script, download or analytics', () => {
  const pj = JSON.parse(read('package.json'));
  assert.equal(pj.name, NAME);
  assert.equal(pj.version, VERSION);
  assert.equal(pj.scripts.install, undefined);
  assert.equal(pj.scripts.postinstall, undefined);
  assert.equal(pj.scripts.preinstall, undefined);
  assert.equal(pj.dependencies['prebuild-install'], undefined);
  assert.equal(pj.dependencies['node-machine-id'], undefined);
  assert.equal(pj.binary, undefined);
  assert.equal(pj.gypfile, false);
  assert.ok(!existsSync(join(pkg, 'binding.gyp')), 'npm would run node-gyp at install');
  assert.equal(pj.exports['./scripts/submit-analytics'], undefined);
  assert.ok(pj.keywords.includes('react-native') && pj.keywords.includes('database'));
  assertMetadata(pj);
  assert.ok(!existsSync(join(pkg, 'dist/scripts/submit-analytics.js')));
  assert.ok(!existsSync(join(pkg, 'scripts/submit-analytics.js')));
});

test('licence files: LICENSE, NOTICE, CHANGES-FROM-UPSTREAM.md, trademark notice', () => {
  for (const f of ['LICENSE', 'NOTICE', 'CHANGES-FROM-UPSTREAM.md', 'checksums.txt']) assert.ok(existsSync(join(pkg, f)), f);
  assert.match(read('NOTICE'), /not affiliated with, sponsored by or endorsed by MongoDB/);
  assert.match(read('README.md'), /not affiliated with or endorsed by MongoDB/);
  assert.match(read('LICENSE'), /Apache License/);
});

test('Node: one binary per platform, loaded by platform', () => {
  for (const t of NODE_TARGETS) assert.ok(existsSync(join(pkg, 'prebuilds/node', t, 'realm.node')), t);
  const binding = read('dist/platform/node/binding.js');
  assert.match(binding, /prebuilds\/node\/\$\{process\.platform\}-\$\{process\.arch\}\/realm\.node/);
  assert.match(binding, /Modified by Pomwik, 2026/);
});

test('iOS: podspec uses install_modules_dependencies (realm/realm-js#7157)', () => {
  const podspec = read('RealmJS.podspec');
  assert.match(podspec, /install_modules_dependencies\(s\)/);
  assert.match(podspec, /respond_to\?\(:install_modules_dependencies, true\)/);
  assert.equal(podspec.match(/s\.dependency 'React'/g).length, 1, 'fallback for old React Native only');
  assert.doesNotMatch(podspec, /'\$\(inherited\) REALM_ENABLE_SYNC=1'/, 'v20 has no sync');
  assert.match(podspec, /'GCC_PREPROCESSOR_DEFINITIONS' => '\$\(inherited\)',/);
  assert.match(read('CHANGES-FROM-UPSTREAM.md'), /TPXP/);
  // install_modules_dependencies appends to HEADER_SEARCH_PATHS as a string: an array would become ["..."]
  assert.match(podspec, /'HEADER_SEARCH_PATHS' => '"\$\{PODS_TARGET_SRCROOT\}\/bindgen\/vendor\/realm-core\/bindgen\/src\/"',/);
});

test('Xcode 26.4: no header specializes std::is_pod any more (realm/realm-js#7115)', () => {
  const headers = walk(join(pkg, 'prebuilds/apple')).filter((f) => /\.(h|hpp)$/.test(f));
  assert.ok(headers.length > 100);
  const offending = headers.filter((f) => /struct\s+is_pod\s*</.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offending, []);
});

test('Xcode 26.4: the patched s2 headers still compile (no regression; this clang accepts upstream too)', { skip: !hasClang() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterdb-s2-'));
  const inc = join(pkg, 'prebuilds/apple/realm-core.xcframework/ios-arm64/Headers');
  writeFileSync(
    join(dir, 'check.cpp'),
    '#include <s2/s1angle.h>\n#include <s2/s2latlng.h>\n#include <s2/s2cellid.h>\n#include <s2/r1interval.h>\n#include <s2/util/math/vector3-inl.h>\nint main() { S1Angle a = S1Angle::Degrees(1); return a.degrees() > 0 ? 0 : 1; }\n',
  );
  execFileSync('clang++', ['-std=c++20', '-fsyntax-only', '-w', `-I${inc}`, `-I${join(inc, 'external')}`, join(dir, 'check.cpp')], { stdio: 'pipe' });
});

test('Android: OpenSSL is bundled for every ABI and used before any download', () => {
  for (const abi of Object.keys(ANDROID_ABIS)) {
    const deps = readdirSync(join(pkg, 'prebuilds/android', abi, 'deps'));
    assert.equal(deps.length, 1, abi);
    assert.equal(deps[0], `openssl-${OPENSSL}-${ANDROID_ABIS[abi]}-android.tar.gz`);
    assert.match(read(`prebuilds/android/${abi}/share/cmake/Realm/RealmConfig.cmake`), new RegExp(`realm_acquire_dependency\\(openssl ${OPENSSL.replace(/\./g, '\\.')} `));
    const cmake = read(`prebuilds/android/${abi}/share/cmake/Realm/AcquireRealmDependency.cmake`);
    assert.ok(cmake.indexOf('if(EXISTS "${DEP_LOCAL}")') < cmake.indexOf('file(DOWNLOAD'), abi);
  }
});

test('Android: the CMake script really extracts the bundled OpenSSL (no NDK needed)', { skip: !cmakeBin() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterdb-cmake-'));
  const share = join(pkg, 'prebuilds/android/arm64-v8a/share/cmake/Realm');
  writeFileSync(
    join(dir, 'check.cmake'),
    `set(ANDROID ON)\nset(CMAKE_SYSTEM_NAME Android)\nset(CMAKE_ANDROID_ARCH_ABI arm64-v8a)\ninclude("${share}/AcquireRealmDependency.cmake")\nrealm_acquire_dependency(openssl ${OPENSSL} OUT)\nif(NOT EXISTS "\${OUT}")\n  message(FATAL_ERROR "include.cmake missing: \${OUT}")\nendif()\nmessage(STATUS "OK \${OUT}")\n`,
  );
  const log = execFileSync(cmakeBin(), ['-P', join(dir, 'check.cmake')], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  assert.ok(existsSync(join(dir, `openssl-${OPENSSL}/include.cmake`)));
  assert.ok(existsSync(join(dir, `openssl-${OPENSSL}/lib/libcrypto.a`)));
  assert.match(readFileSync(join(dir, `openssl-${OPENSSL}/include/openssl/opensslv.h`), 'utf8'), new RegExp(`OPENSSL_VERSION_TEXT.*OpenSSL ${OPENSSL.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(log, /Getting https:\/\/static\.realm\.io/);
});

test('install offline as « realm » through an alias, open, write, query, encrypt (Node)', () => {
  const app = mkdtempSync(join(tmpdir(), 'afterdb-app-'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module', dependencies: { realm: `file:${tarball}` } }));
  // The package has no install script, so nothing can be downloaded during install (dependencies come from the npm cache)
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--ignore-scripts=false'], { cwd: app, stdio: 'pipe', timeout: 300_000 });
  const installed = JSON.parse(readFileSync(join(app, 'node_modules/realm/package.json'), 'utf8'));
  assert.equal(installed.name, NAME);
  writeFileSync(
    join(app, 'smoke.mjs'),
    `import Realm from 'realm';
const Task = { name: 'Task', primaryKey: '_id', properties: { _id: 'int', title: 'string', done: { type: 'bool', default: false }, tags: 'string[]' } };
const key = new Int8Array(64).map((_, i) => i);
const realm = await Realm.open({ schema: [Task], path: 'test.realm', encryptionKey: key });
realm.write(() => { for (let i = 0; i < 100; i++) realm.create('Task', { _id: i, title: 'Tâche ' + i, done: i % 3 === 0, tags: i % 2 ? ['a'] : [] }); });
const done = realm.objects('Task').filtered('done == true AND tags.@count == 0').sorted('_id');
console.log(JSON.stringify({ count: realm.objects('Task').length, done: done.length, first: done[0].title, version: Realm.schemaVersion('test.realm', key) }));
realm.close();
let refused = false;
try { await Realm.open({ schema: [Task], path: 'test.realm' }); } catch { refused = true; }
console.log(JSON.stringify({ refusedWithoutKey: refused }));
// Realm on Node keeps the event loop alive after a failed open (upstream behaviour): exit explicitly
process.exit(0);
`,
  );
  const lines = execFileSync('node', ['smoke.mjs'], { cwd: app, encoding: 'utf8', timeout: 60_000 }).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { count: 100, done: 17, first: 'Tâche 0', version: 0 });
  assert.equal(lines[1].refusedWithoutKey, true);
});

test('afterdb-react: react-native is an optional peer, not a nested dependency (realm/realm-js#7066)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterdb-react-'));
  execFileSync('tar', ['-xzf', reactTarball, '-C', dir]);
  const pj = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'));
  assert.equal(pj.name, REACT_NAME);
  assert.equal(pj.optionalDependencies?.['react-native'], undefined);
  assert.ok(pj.peerDependencies['react-native']);
  assert.equal(pj.peerDependenciesMeta['react-native'].optional, true);
  assert.ok(existsSync(join(dir, 'package/NOTICE')));
  assert.ok(existsSync(join(dir, 'package/LICENSE')));
});

test('afterdb-react: metadata, and a NOTICE without OpenSSL (the package ships none)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afterdb-react-'));
  execFileSync('tar', ['-xzf', reactTarball, '-C', dir]);
  const pj = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'));
  assertMetadata(pj);
  assert.equal(pj.files.filter((f) => f === 'LICENSE').length, 1);
  for (const f of ['NOTICE', 'CHANGES-FROM-UPSTREAM.md']) assert.ok(pj.files.includes(f), f);
  const notice = readFileSync(join(dir, 'package/NOTICE'), 'utf8');
  assert.match(notice, /^afterdb-react\n/);
  assert.match(notice, /not affiliated with, sponsored by or endorsed by MongoDB/);
  assert.doesNotMatch(notice, /OpenSSL/);
  assert.equal(walk(join(dir, 'package')).filter((f) => /openssl/i.test(f)).length, 0);
  assert.match(read('NOTICE'), /OpenSSL 3\.5\.9/, 'the realm package does ship OpenSSL');
  assert.match(readFileSync(join(dir, 'package/README.md'), 'utf8'), /^# @pomwik\/afterdb-react\n/);
});

function hasClang() {
  try {
    execFileSync('clang++', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function cmakeBin() {
  for (const c of ['cmake', join(process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Library/Android/sdk'), 'cmake/3.22.1/bin/cmake')]) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe' });
      return c;
    } catch {}
  }
  return null;
}
