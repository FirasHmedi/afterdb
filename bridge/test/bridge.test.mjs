// Tests of the built packages (run `npm run build` first). Usage: node --test bridge/test
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ANDROID_ABIS, DESCRIPTION, IOS_FALLBACK_MIN, NAME, NODE_TARGETS, OPENSSL, VERSION } from '../build.mjs';
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
// Temporary folders are removed after the run (the offline install alone leaves about 700 MB)
const temps = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
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
  // Apache-2.0 §4(b): the replaced README says so; Realm® at the first mention in the README and the list of changes
  assert.match(read('README.md'), /^Modified by Pomwik, 2026: this file replaces the upstream README/m);
  const changes = read('CHANGES-FROM-UPSTREAM.md');
  for (const text of [read('README.md'), changes]) assert.equal(text.indexOf('Realm'), text.indexOf('Realm®'));
  assert.ok(changes.includes('Realm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB.'));
  assert.match(changes, /`include\.cmake` that is upstream's file, byte-identical to the one in realm's `openssl-3\.3\.1` archives/);
});

test('README of the package: only what was run is claimed as tested', () => {
  const readme = read('README.md');
  // Each claim matches a run recorded in docs/TEST-RESULTS.md (2026-11-06); iOS beyond RN 0.88.1 is not claimed
  assert.match(readme, /Android, React Native 0\.88\.1: Debug and release builds for the 4 ABIs/);
  assert.match(readme, /Android, React Native 0\.86\.3 and 0\.87\.1, and Expo SDK 56, 57 and 58/);
  assert.match(readme, /iOS, React Native 0\.88\.1, Xcode 26\.4\.1 and 26\.6: on the simulator/);
  assert.match(readme, /^Not tested yet: real devices, and iOS with React Native 0\.86\/0\.87 or Expo\.$/m);
  const ios = readme.split('\n').filter((l) => /iOS/.test(l));
  assert.ok(ios.every((l) => !/0\.8[67]|Expo/.test(l) || l.startsWith('Not tested yet')), 'iOS claimed beyond RN 0.88.1');
});

test('Node: one binary per platform, loaded by platform', () => {
  for (const t of NODE_TARGETS) assert.ok(existsSync(join(pkg, 'prebuilds/node', t, 'realm.node')), t);
  const binding = read('dist/platform/node/binding.js');
  assert.match(binding, /prebuilds\/node\/\$\{process\.platform\}-\$\{process\.arch\}\/realm\.node/);
  assert.match(binding, /Modified by Pomwik, 2026/);
  // binding.js was the only user of the "#realm.node" subpath import: the entry is gone and nothing refers to it
  assert.equal(JSON.parse(read('package.json')).imports, undefined);
  assert.deepEqual(walk(join(pkg, 'dist')).filter((f) => readFileSync(f, 'utf8').includes('#realm.node')), []);
  for (const f of ['index.react-native.js', 'react-native.config.js']) assert.ok(!read(f).includes('#realm.node'), f);
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
  // the stale upstream comment about Sync went with the define, and both changes carry the notice
  assert.doesNotMatch(podspec, /compiled with Sync enabled/);
  assert.match(podspec, /# Modified by Pomwik, 2026[^\n]*REALM_ENABLE_SYNC=1 removed[^\n]*\n\s*'GCC_PREPROCESSOR_DEFINITIONS' => '\$\(inherited\)',\n/);
});

test('iOS: podspec minimum iOS version is React Native\'s, not 9.0', () => {
  const podspec = read('RealmJS.podspec');
  assert.doesNotMatch(podspec, /'9\.0'/);
  assert.match(
    podspec,
    new RegExp(`# Modified by Pomwik, 2026[^\\n]*\\n  s\\.platform += :ios, \\(respond_to\\?\\(:min_ios_version_supported, true\\) \\? min_ios_version_supported : '${IOS_FALLBACK_MIN.replace('.', '\\.')}'\\)\\n`),
  );
  assert.equal(IOS_FALLBACK_MIN, '15.1');
});

// Evaluates the shipped podspec the way CocoaPods does (eval inside the Pod module), with a stub Pod::Spec that
// records the attributes: once without React Native's helpers, once with stubs of min_ios_version_supported and
// install_modules_dependencies (defined by React Native's react_native_pods.rb when the Podfile requires it).
test('iOS: the podspec evaluates in Ruby, with and without React Native\'s helpers', { skip: !has('ruby', ['-v']) }, () => {
  const dir = tmp('afterdb-podspec-');
  writeFileSync(
    join(dir, 'eval.rb'),
    `require 'json'
class Object
  def present?; !(nil? || (respond_to?(:empty?) && empty?)); end
end
module Pod
  class Spec
    attr_reader :attrs
    def initialize; @attrs = {}; yield self; $spec = self; end
    def method_missing(name, *args)
      key = name.to_s
      if key.end_with?('=') then @attrs[key.chomp('=')] = args.length == 1 ? args[0] : args
      else (@attrs[key] ||= []) << args end
      nil
    end
  end
  def self._eval_podspec(string, path); eval(string, nil, path); end
end
podspec, mode = ARGV
if mode == 'rn'
  def min_ios_version_supported; '16.4'; end
  def install_modules_dependencies(spec); spec.dependency('React-Core'); end
end
Pod._eval_podspec(File.read(podspec), podspec)
puts JSON.generate($spec.attrs, ascii_only: true)
`,
  );
  const evaluate = (mode) => JSON.parse(execFileSync('ruby', ['-E', 'US-ASCII', join(dir, 'eval.rb'), join(pkg, 'RealmJS.podspec'), mode], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }));
  const plain = evaluate('plain');
  assert.deepEqual(plain.platform, ['ios', IOS_FALLBACK_MIN]);
  assert.deepEqual(plain.dependency, [['React']]);
  const rn = evaluate('rn');
  assert.deepEqual(rn.platform, ['ios', '16.4']);
  assert.deepEqual(rn.dependency, [['React-Core']]);
  // summary, authors and homepage come from package.json (read even with a non-UTF-8 locale)
  assert.equal(rn.summary, DESCRIPTION);
  assert.deepEqual(rn.authors, { name: 'Pomwik', email: 'hello@pomwik.com', url: 'https://pomwik.com' });
  assert.equal(rn.homepage, 'https://github.com/FirasHmedi/afterdb');
  assert.equal(rn.pod_target_xcconfig.GCC_PREPROCESSOR_DEFINITIONS, '$(inherited)');
  rmSync(dir, { recursive: true, force: true });
});

test('Android: consumer ProGuard rules keep the binding classes the native code looks up (R8 in release builds)', () => {
  const gradle = read('binding/android/build.gradle');
  assert.match(gradle, /\n    defaultConfig \{\n        \/\/ Modified by Pomwik, 2026[^\n]*\n        consumerProguardFiles 'consumer-rules\.pro'\n/);
  const rules = read('binding/android/consumer-rules.pro');
  assert.match(rules, /^-keep class io\.realm\.react\.\*\* \{ \*; \}$/m);
  assert.match(rules, /Modified by Pomwik, 2026/);
  // the class that JNI_OnLoad looks up by name must be inside the kept package
  assert.ok(existsSync(join(pkg, 'binding/android/src/main/java/io/realm/react/util/SSLHelper.java')));
});

test('Android: librealm.so is built with the app\'s NDK (rootProject.ext.ndkVersion) when it sets one', () => {
  const gradle = read('binding/android/build.gradle');
  const android = gradle.slice(gradle.indexOf('\nandroid {'), gradle.indexOf('\nproject.dependencies'));
  assert.match(android, /\n    \/\/ Modified by Pomwik, 2026[^\n]*\n    if \(rootProject\.hasProperty\('ndkVersion'\)\) \{\n        ndkVersion rootProject\.ext\.ndkVersion\n    \}\n/);
  // set only inside that condition: without it, AGP keeps its default NDK
  assert.equal(gradle.match(/^\s*ndkVersion\b/gm).length, 1);
  assert.equal(gradle.match(/^\s*ndkPath\b/gm), null);
});

test('Xcode 26.4: no header specializes std::is_pod any more (realm/realm-js#7115)', () => {
  const headers = walk(join(pkg, 'prebuilds/apple')).filter((f) => /\.(h|hpp)$/.test(f));
  assert.ok(headers.length > 100);
  const offending = headers.filter((f) => /struct\s+is_pod\s*</.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offending, []);
});

test('Xcode 26.4: the patched s2 headers still compile (no regression; this clang accepts upstream too)', { skip: !hasClang() }, () => {
  const dir = tmp('afterdb-s2-');
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
    // the SHA-256 of the shipped archive is recorded in the CMake file and checked before the archive is copied
    const sha = createHash('sha256').update(readFileSync(join(pkg, 'prebuilds/android', abi, 'deps', deps[0]))).digest('hex');
    assert.ok(cmake.includes(`set(AFTERDB_BUNDLED_SHA256_${deps[0]} "${sha}")`), abi);
    assert.ok(cmake.indexOf('file(SHA256 "${DEP_LOCAL}"') < cmake.indexOf('file(COPY_FILE'), abi);
    assert.match(read('checksums.txt'), new RegExp(`^${sha}  prebuilds/android/${abi}/deps/`, 'm'));
  }
});

test('Android: the OpenSSL archives record no local account, and their include.cmake is upstream\'s', () => {
  for (const abi of Object.keys(ANDROID_ABIS)) {
    const archive = join(pkg, 'prebuilds/android', abi, 'deps', `openssl-${OPENSSL}-${ANDROID_ABIS[abi]}-android.tar.gz`);
    // owner column(s) of tar -tv: « 0/0 » for GNU tar, « 0 0 » for bsdtar
    const owners = new Set(execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n').map((l) => {
      const f = l.trim().split(/\s+/);
      return f[1].includes('/') ? f[1] : `${f[2]}/${f[3]}`;
    }));
    assert.deepEqual([...owners], ['0/0'], abi);
    // byte-identical to the include.cmake of realm's openssl-3.3.1 archives
    const includeCmake = execFileSync('tar', ['-xOzf', archive, './include.cmake']);
    assert.equal(createHash('sha256').update(includeCmake).digest('hex'), '00510e01b73e57960852921903df79ca5c9e54086483a349d3d05dff7d1cf28a', abi);
  }
});

/** Runs realm_acquire_dependency(openssl) of the AcquireRealmDependency.cmake in `share` with `cmake -P`, in a new folder */
function acquireOpenSSL(share) {
  const dir = tmp('afterdb-cmake-');
  writeFileSync(
    join(dir, 'check.cmake'),
    `set(ANDROID ON)\nset(CMAKE_SYSTEM_NAME Android)\nset(CMAKE_ANDROID_ARCH_ABI arm64-v8a)\ninclude("${share}/AcquireRealmDependency.cmake")\nrealm_acquire_dependency(openssl ${OPENSSL} OUT)\nif(NOT EXISTS "\${OUT}")\n  message(FATAL_ERROR "include.cmake missing: \${OUT}")\nendif()\nmessage(STATUS "OK \${OUT}")\n`,
  );
  const r = spawnSync(cmakeBin(), ['-P', join(dir, 'check.cmake')], { cwd: dir, encoding: 'utf8' });
  return { dir, status: r.status, log: r.stdout + r.stderr };
}

test('Android: the CMake script checks the SHA-256 of the bundled OpenSSL, then extracts it (no NDK needed)', { skip: !cmakeBin() }, () => {
  const { dir, status, log } = acquireOpenSSL(join(pkg, 'prebuilds/android/arm64-v8a/share/cmake/Realm'));
  try {
    assert.equal(status, 0, log);
    assert.match(log.replace(/\s+/g, ' '), new RegExp(`Using bundled \\S*/openssl-${OPENSSL.replace(/\./g, '\\.')}-arm64-android\\.tar\\.gz \\(SHA-256 checked\\)`));
    assert.ok(existsSync(join(dir, `openssl-${OPENSSL}/include.cmake`)));
    assert.ok(existsSync(join(dir, `openssl-${OPENSSL}/lib/libcrypto.a`)));
    assert.match(readFileSync(join(dir, `openssl-${OPENSSL}/include/openssl/opensslv.h`), 'utf8'), new RegExp(`OPENSSL_VERSION_TEXT.*OpenSSL ${OPENSSL.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(log, /Getting https:\/\/static\.realm\.io/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Android: a damaged bundled OpenSSL archive stops the CMake configure (FATAL_ERROR, nothing extracted or downloaded)', { skip: !cmakeBin() }, () => {
  // same layout as the package: <abi>/share/cmake/Realm/*.cmake and <abi>/deps/<archive>, with one byte changed
  const abi = tmp('afterdb-damaged-');
  const name = `openssl-${OPENSSL}-arm64-android.tar.gz`;
  cpSync(join(pkg, 'prebuilds/android/arm64-v8a/share/cmake/Realm'), join(abi, 'share/cmake/Realm'), { recursive: true });
  const archive = readFileSync(join(pkg, 'prebuilds/android/arm64-v8a/deps', name));
  const expected = createHash('sha256').update(archive).digest('hex');
  archive[archive.length >> 1] ^= 0xff;
  mkdirSync(join(abi, 'deps'));
  writeFileSync(join(abi, 'deps', name), archive);
  const { dir, status, log } = acquireOpenSSL(join(abi, 'share/cmake/Realm'));
  try {
    assert.notEqual(status, 0, log);
    // CMake wraps long messages over several lines
    const message = log.replace(/\s+/g, ' ');
    assert.match(message, /CMake Error/);
    assert.match(message, new RegExp(`SHA-256 mismatch for the bundled \\S*/${name.replace(/\./g, '\\.')}: ${createHash('sha256').update(archive).digest('hex')}, expected ${expected}\\.`));
    assert.ok(!existsSync(join(dir, `openssl-${OPENSSL}/include.cmake`)), 'extracted anyway');
    assert.ok(!existsSync(join(dir, `openssl-${OPENSSL}/openssl.tar.gz`)), 'copied anyway');
    assert.doesNotMatch(log, /Getting https:\/\/static\.realm\.io/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(abi, { recursive: true, force: true });
  }
});

test('install offline as « realm » through an alias, open, write, query, encrypt (Node)', () => {
  const app = tmp('afterdb-app-');
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
  const dir = tmp('afterdb-react-');
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
  const dir = tmp('afterdb-react-');
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
  const readme = readFileSync(join(dir, 'package/README.md'), 'utf8');
  assert.match(readme, /^# @pomwik\/afterdb-react\n/);
  assert.match(readme, /^Modified by Pomwik, 2026: this file replaces the upstream README/m);
  assert.equal(readme.indexOf('Realm'), readme.indexOf('Realm®'));
});

function hasClang() {
  return has('clang++', ['--version']);
}

function has(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'pipe' });
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
