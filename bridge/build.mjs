#!/usr/bin/env node
// Builds the afterdb package: the official realm@20.2.0 npm tarball (Apache-2.0), verified by its npm
// integrity hash, with a few patches that keep it building on current React Native, Expo and Xcode.
// The prebuilt realm-core engine is reused as is: nothing here recompiles C++.
//
// Usage: node bridge/build.mjs [--out bridge/out]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
export const UPSTREAM = { name: 'realm', version: '20.2.0', integrity: 'sha512-xkfczMrxnZK1KlJ5JBWGMe2Cs48+p1D8T9r8TO6FrZhnm2KUUhBJPOpOIoJ4h1O20fCxlfJ2pIg3mplJTUgF6g==' };
export const NAME = '@pomwik/afterdb';
export const VERSION = '20.3.0';
const CACHE = join(here, '.cache');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(here, 'out');

/** Node N-API binaries published by the upstream project; vendored so that installs never download anything. */
export const NODE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];
/** SHA-256 of the upstream Node binaries, pinned on 2026-11-06 (verified on download and on every cache reuse) */
const NODE_SHA256 = {
  'darwin-arm64': '0da6dc8ee864f4c381ed89068bf51aeb181822f0ab5aa615417c884c7d5ba437',
  'darwin-x64': '7e141c7722b6b0a3ebff3c5546f7b51fcde6d27d2dd6bd84ec500c184d167422',
  'linux-x64': 'e80871c908f966c6e763ce57bf4ccb978e4e86073372fcde320e63e83f526938',
  'linux-arm64': '0c993de91dab7d2f0e350d2c490591dec14c4310c8ce37c0a3a9240239a97a3c',
  'win32-x64': '95e8666624304adbffe80253197cf8357c5325258307e336658268a6a6319aec',
};
const NODE_URL = (t) => `https://static.realm.io/realm-js-prebuilds/${UPSTREAM.version}/realm-v${UPSTREAM.version}-napi-v6-${t}.tar.gz`;
/**
 * OpenSSL for Android. Upstream downloads 3.3.1 (end of life since 2026-04-09) at compile time; we ship 3.5 LTS,
 * built by bridge/openssl/build-openssl.sh from the checksummed OpenSSL source release.
 */
export const ANDROID_ABIS = { 'arm64-v8a': 'arm64', 'armeabi-v7a': 'arm', x86: 'x86', x86_64: 'x64' };
const UPSTREAM_OPENSSL = '3.3.1';
export const OPENSSL = '3.5.9';
/** Minimum iOS version of the podspec when React Native does not define min_ios_version_supported */
export const IOS_FALLBACK_MIN = '15.1';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Downloads once into the cache; the SHA-256 is checked both after download and when the cached copy is reused. */
async function download(url, file, expected) {
  let buf;
  if (existsSync(file)) buf = readFileSync(file);
  else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
  }
  if (expected && sha256(buf) !== expected) {
    rmSync(file, { force: true });
    throw new Error(`${url}: SHA-256 ${sha256(buf)} does not match the pinned ${expected}`);
  }
  return buf;
}

/** Replaces `from` by `to` in a file; fails unless `from` occurs exactly `times` times (default once). */
function patch(file, from, to, times = 1) {
  const text = readFileSync(file, 'utf8');
  const n = text.split(from).length - 1;
  if (n !== times) throw new Error(`patch ${file}: expected ${times} occurrence(s), found ${n}:\n${from.slice(0, 200)}`);
  writeFileSync(file, text.split(from).join(to));
}

const MARK = 'Modified by Pomwik, 2026, see CHANGES-FROM-UPSTREAM.md';

export const DESCRIPTION =
  'Independent, maintained fork of the open-source Realm® JavaScript SDK v20 (realm-js, Apache-2.0): local database, no sync, with build fixes for current React Native and Xcode. Not affiliated with or endorsed by MongoDB, Inc.';
/** package.json fields shared by both packages (replace upstream's MongoDB author, homepage, repository and bugs) */
export const PROJECT = {
  author: { name: 'Pomwik', email: 'hello@pomwik.com', url: 'https://pomwik.com' },
  homepage: 'https://github.com/FirasHmedi/afterdb',
  repository: { type: 'git', url: 'git+https://github.com/FirasHmedi/afterdb.git' },
  bugs: { url: 'https://github.com/FirasHmedi/afterdb/issues' },
};

export async function build() {
  // 1. Official tarball, checked against the integrity hash published by the npm registry
  const meta = await (await fetch(`https://registry.npmjs.org/${UPSTREAM.name}/${UPSTREAM.version}`)).json();
  if (meta.dist.integrity !== UPSTREAM.integrity) throw new Error(`npm registry integrity changed: ${meta.dist.integrity}`);
  const tgz = await download(meta.dist.tarball, join(CACHE, `${UPSTREAM.name}-${UPSTREAM.version}.tgz`));
  const [algo, b64] = UPSTREAM.integrity.split('-');
  if (createHash(algo).update(tgz).digest('base64') !== b64) throw new Error('Upstream tarball does not match its npm integrity hash');

  const work = join(out, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xzf', join(CACHE, `${UPSTREAM.name}-${UPSTREAM.version}.tgz`), '-C', work]);
  const pkg = join(work, 'package');
  const checksums = [];

  // 2. package.json: new name, no install or postinstall script (no download, no analytics)
  const pj = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  for (const k of ['install', 'postinstall']) {
    if (!pj.scripts?.[k]) throw new Error(`package.json: script ${k} not found upstream`);
    delete pj.scripts[k];
  }
  for (const d of ['prebuild-install', 'node-machine-id']) {
    if (!pj.dependencies?.[d]) throw new Error(`package.json: dependency ${d} not found upstream`);
    delete pj.dependencies[d];
  }
  delete pj.binary;
  if (!pj.exports['./scripts/submit-analytics']) throw new Error("package.json: exports['./scripts/submit-analytics'] not found upstream");
  delete pj.exports['./scripts/submit-analytics'];
  if (!pj.keywords?.includes('mongodb')) throw new Error('package.json: keyword mongodb not found upstream');
  Object.assign(pj, {
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
    keywords: pj.keywords.filter((k) => k !== 'mongodb'),
    ...PROJECT,
    afterdb: { upstream: `${UPSTREAM.name}@${UPSTREAM.version}`, upstreamIntegrity: meta.dist.integrity },
  });
  // binding.gyp only rebuilds the Node binary from source (shipped prebuilt here): without an install script npm
  // would run node-gyp on it automatically, hence gypfile: false and no binding.gyp in the package
  pj.gypfile = false;
  pj.files = [...pj.files.filter((f) => f !== 'binding.gyp'), 'prebuilds/node', 'LICENSE', 'NOTICE', 'CHANGES-FROM-UPSTREAM.md'];
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(pj, null, 2) + '\n');
  rmSync(join(pkg, 'binding.gyp'), { force: true });
  for (const f of ['dist/scripts/submit-analytics.js', 'dist/scripts/submit-analytics.d.ts', 'dist/scripts/submit-analytics.js.map', 'scripts/submit-analytics.js']) rmSync(join(pkg, f), { force: true });

  // 3. Node binaries for every supported platform, loaded by platform and architecture
  for (const t of NODE_TARGETS) {
    const buf = await download(NODE_URL(t), join(CACHE, 'node', `${t}.tar.gz`), NODE_SHA256[t]);
    const dir = join(out, 'node-' + t);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', join(CACHE, 'node', `${t}.tar.gz`), '-C', dir]);
    const found = execFileSync('find', [dir, '-name', 'realm.node'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (!found) throw new Error(`No realm.node in ${NODE_URL(t)}`);
    mkdirSync(join(pkg, 'prebuilds', 'node', t), { recursive: true });
    cpSync(found, join(pkg, 'prebuilds', 'node', t, 'realm.node'));
    checksums.push(`${sha256(buf)}  ${NODE_URL(t)}`);
  }
  patch(
    join(pkg, 'dist/platform/node/binding.js'),
    'const nativeModule = require("#realm.node");',
    `// ${MARK}: binaries for every platform ship in the package (no download at install).
const nativeModule = (() => {
    try {
        return require(\`../../../prebuilds/node/\${process.platform}-\${process.arch}/realm.node\`);
    }
    catch (err) {
        if (err && err.code !== "MODULE_NOT_FOUND") throw err;
        throw new Error(\`No prebuilt Node binary for \${process.platform}-\${process.arch} in this package (shipped: ${NODE_TARGETS.join(', ')}). React Native apps do not need it.\`);
    }
})();`,
  );

  // 4. iOS: link React Native >= 0.86 pods built as frameworks (realm/realm-js#7157)
  patch(
    join(pkg, 'RealmJS.podspec'),
    "  s.dependency 'React'\n",
    `  # ${MARK}: realm/realm-js#7157
  if respond_to?(:install_modules_dependencies, true)
    # React Native >= 0.71: pulls in React-Core, React-jsi, ReactCommon/turbomodule/core and the JS engine.
    # Depending on the umbrella 'React' pod alone no longer links them when pods are built as frameworks (RN >= 0.86).
    install_modules_dependencies(s)
  else
    s.dependency 'React'
  end
`,
  );

  // 4b. v20 has no Device Sync: REALM_ENABLE_SYNC=1 is a leftover that no shipped header or binding source reads.
  //     The upstream comment above it (« compiled with Sync enabled ») is replaced too.
  patch(
    join(pkg, 'RealmJS.podspec'),
    `                                # Signaling to headers that Realm was compiled with Sync enabled
                                'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) REALM_ENABLE_SYNC=1',`,
    `                                # ${MARK}: no define of our own; REALM_ENABLE_SYNC=1 removed (v20 has no sync, nothing reads it)
                                'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited)',`,
  );

  // 4c. install_modules_dependencies interpolates HEADER_SEARCH_PATHS into a string: an array would become
  //     ["..."] and break <realm_helpers.h> lookups, so the podspec gives a string (found by the independent review)
  patch(
    join(pkg, 'RealmJS.podspec'),
    `                                'HEADER_SEARCH_PATHS' => [
                                  # Platform independent helpers
                                  '"\${PODS_TARGET_SRCROOT}/bindgen/vendor/realm-core/bindgen/src/"',
                                ]`,
    `                                # ${MARK}: a string, not an array (install_modules_dependencies appends to it as a string)
                                'HEADER_SEARCH_PATHS' => '"\${PODS_TARGET_SRCROOT}/bindgen/vendor/realm-core/bindgen/src/"',`,
  );

  // 4d. Minimum iOS version: upstream says 9.0, below anything React Native >= 0.71 supports. Use React Native's own
  //     minimum (min_ios_version_supported, defined by its react_native_pods.rb) and 15.1 when it is not defined.
  patch(
    join(pkg, 'RealmJS.podspec'),
    "  s.platform               = :ios, '9.0'\n",
    `  # ${MARK}: React Native's minimum iOS version instead of 9.0
  s.platform               = :ios, (respond_to?(:min_ios_version_supported, true) ? min_ios_version_supported : '${IOS_FALLBACK_MIN}')
`,
  );

  // 5. Xcode 26.4: libc++ forbids specializing std::is_pod, which the shipped s2 headers did (realm/realm-js#7115).
  //    Header-only change: the macros become no-ops (the types stay trivially copyable, nothing else relies on them).
  const xc = join(pkg, 'prebuilds/apple/realm-core.xcframework');
  for (const slice of readdirSync(xc).filter((d) => existsSync(join(xc, d, 'Headers/external/s2/base/macros.h')))) {
    const f = join(xc, slice, 'Headers/external/s2/base/macros.h');
    patch(
      f,
      `#define DECLARE_POD(TypeName)                       \\
namespace std {                                    \\
template<> struct is_pod<TypeName> : true_type { }; \\
}                                                   \\
typedef int Dummy_Type_For_DECLARE_POD              \\
`,
      `// ${MARK}: realm/realm-js#7115, no std::is_pod specialization (rejected by Xcode 26.4)
#define DECLARE_POD(TypeName)                       \\
typedef int Dummy_Type_For_DECLARE_POD              \\
`,
    );
    patch(
      f,
      `#define PROPAGATE_POD_FROM_TEMPLATE_ARGUMENT(TemplateName)             \\
namespace std {                                                       \\
template <typename T> struct is_pod<TemplateName<T> > : std::is_trivial<T> { }; \\
}                                                                      \\
typedef int Dummy_Type_For_PROPAGATE_POD_FROM_TEMPLATE_ARGUMENT`,
      `#define PROPAGATE_POD_FROM_TEMPLATE_ARGUMENT(TemplateName)             \\
typedef int Dummy_Type_For_PROPAGATE_POD_FROM_TEMPLATE_ARGUMENT`,
    );
  }

  // 6. Android: OpenSSL is shipped in the package instead of being downloaded at compile time
  for (const [abi, arch] of Object.entries(ANDROID_ABIS)) {
    const name = `openssl-${OPENSSL}-${arch}-android.tar.gz`;
    const built = join(CACHE, 'openssl', name);
    if (!existsSync(built)) throw new Error(`${built} missing: run bridge/openssl/build-openssl.sh ${OPENSSL}`);
    // Inside a function, CMAKE_CURRENT_LIST_DIR is the caller's folder: record this file's folder when it is included
    patch(
      join(pkg, 'prebuilds/android', abi, 'share/cmake/Realm/AcquireRealmDependency.cmake'),
      'function(realm_acquire_dependency dep_name dep_version out_dep_cmake)',
      `# ${MARK}: folder of the OpenSSL archives shipped in the package
set(AFTERDB_BUNDLED_DEPS_DIR "\${CMAKE_CURRENT_LIST_DIR}/../../../deps")

function(realm_acquire_dependency dep_name dep_version out_dep_cmake)`,
    );
    const buf = readFileSync(built);
    mkdirSync(join(pkg, 'prebuilds/android', abi, 'deps'), { recursive: true });
    writeFileSync(join(pkg, 'prebuilds/android', abi, 'deps', name), buf);
    checksums.push(`${sha256(buf)}  prebuilds/android/${abi}/deps/${name} (built from openssl-${OPENSSL}.tar.gz)`);
    patch(
      join(pkg, 'prebuilds/android', abi, 'share/cmake/Realm/RealmConfig.cmake'),
      `realm_acquire_dependency(openssl ${UPSTREAM_OPENSSL} OPENSSL_CMAKE_INCLUDE_FILE)`,
      `realm_acquire_dependency(openssl ${OPENSSL} OPENSSL_CMAKE_INCLUDE_FILE) # ${MARK}: OpenSSL 3.5 LTS instead of 3.3.1`,
    );
    // One folder per version, so that a build folder left by upstream (OpenSSL 3.3.1) is never reused silently
    patch(join(pkg, 'prebuilds/android', abi, 'share/cmake/Realm/AcquireRealmDependency.cmake'), '\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}', '\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}-\${dep_version}', 4);
    patch(
      join(pkg, 'prebuilds/android', abi, 'share/cmake/Realm/AcquireRealmDependency.cmake'),
      `        set(DEP_URL "https://static.realm.io/downloads/dependencies/\${dep_name}/\${dep_version}/\${dep_name}-\${dep_version}-\${_target_architecture_\${CMAKE_SYSTEM_NAME}_\${_target_architecture}}-\${_target_platform_name_\${CMAKE_SYSTEM_NAME}}.tar.gz")
        message(STATUS "Getting \${DEP_URL}...")
        file(DOWNLOAD "\${DEP_URL}" "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}-\${dep_version}/\${dep_name}.tar.gz" STATUS download_status)

        list(GET download_status 0 status_code)
        if (NOT "\${status_code}" STREQUAL "0")
            message(FATAL_ERROR "Downloading \${url}... Failed. Status: \${download_status}")
        endif()
`,
      `        # ${MARK}: use the copy shipped in the package, download only as a fallback
        set(DEP_FILE_NAME "\${dep_name}-\${dep_version}-\${_target_architecture_\${CMAKE_SYSTEM_NAME}_\${_target_architecture}}-\${_target_platform_name_\${CMAKE_SYSTEM_NAME}}.tar.gz")
        set(DEP_LOCAL "\${AFTERDB_BUNDLED_DEPS_DIR}/\${DEP_FILE_NAME}")
        if(EXISTS "\${DEP_LOCAL}")
            message(STATUS "Using bundled \${DEP_LOCAL}")
            file(MAKE_DIRECTORY "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}-\${dep_version}")
            file(COPY_FILE "\${DEP_LOCAL}" "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}-\${dep_version}/\${dep_name}.tar.gz" RESULT copy_result)
            if(NOT copy_result STREQUAL "0")
                message(FATAL_ERROR "Copying \${DEP_LOCAL} failed: \${copy_result}")
            endif()
        else()
            set(DEP_URL "https://static.realm.io/downloads/dependencies/\${dep_name}/\${dep_version}/\${DEP_FILE_NAME}")
            message(STATUS "Getting \${DEP_URL}...")
            file(DOWNLOAD "\${DEP_URL}" "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}-\${dep_version}/\${dep_name}.tar.gz" STATUS download_status)
            list(GET download_status 0 status_code)
            if (NOT "\${status_code}" STREQUAL "0")
                message(FATAL_ERROR "Downloading \${DEP_URL}... Failed. Status: \${download_status}")
            endif()
        endif()
`,
    );
  }

  // 7. Licence files and a visible list of changes (Apache-2.0, section 4)
  writeFileSync(join(pkg, 'checksums.txt'), checksums.join('\n') + '\n');
  pj.files.push('checksums.txt');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(pj, null, 2) + '\n');
  cpSync(join(root, 'LICENSE'), join(pkg, 'LICENSE'));
  cpSync(join(root, 'NOTICE'), join(pkg, 'NOTICE'));
  cpSync(join(root, 'CHANGES-FROM-UPSTREAM.md'), join(pkg, 'CHANGES-FROM-UPSTREAM.md'));
  cpSync(join(here, 'PACKAGE_README.md'), join(pkg, 'README.md'));

  const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: pkg, encoding: 'utf8' }).trim().split('\n').pop();
  return { tarball: join(out, file), pkg };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { tarball } = await build();
  console.log(tarball);
}
