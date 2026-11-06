#!/usr/bin/env node
// Builds the keelstore package: the official realm@20.2.0 npm tarball (Apache-2.0), verified by its npm
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
export const UPSTREAM = { name: 'realm', version: '20.2.0' };
/** Placeholder name and version until Firas picks the final name (plan, part C §2). */
export const NAME = '@pomwik/keelstore';
export const VERSION = '20.3.0';
const CACHE = join(here, '.cache');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(here, 'out');

/** Node N-API binaries published by the upstream project; vendored so that installs never download anything. */
export const NODE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];
const NODE_URL = (t) => `https://static.realm.io/realm-js-prebuilds/${UPSTREAM.version}/realm-v${UPSTREAM.version}-napi-v6-${t}.tar.gz`;
/**
 * OpenSSL for Android. Upstream downloads 3.3.1 (end of life since 2026-04-09) at compile time; we ship 3.5 LTS,
 * built by bridge/openssl/build-openssl.sh from the checksummed OpenSSL source release.
 */
export const ANDROID_ABIS = { 'arm64-v8a': 'arm64', 'armeabi-v7a': 'arm', x86: 'x86', x86_64: 'x64' };
const UPSTREAM_OPENSSL = '3.3.1';
export const OPENSSL = '3.5.9';
const UPSTREAM_OPENSSL_URL = (arch) => `https://static.realm.io/downloads/dependencies/openssl/${UPSTREAM_OPENSSL}/openssl-${UPSTREAM_OPENSSL}-${arch}-android.tar.gz`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url, file) {
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
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

export async function build() {
  // 1. Official tarball, checked against the integrity hash published by the npm registry
  const meta = await (await fetch(`https://registry.npmjs.org/${UPSTREAM.name}/${UPSTREAM.version}`)).json();
  const tgz = await download(meta.dist.tarball, join(CACHE, `${UPSTREAM.name}-${UPSTREAM.version}.tgz`));
  const [algo, b64] = meta.dist.integrity.split('-');
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
  delete pj.exports['./scripts/submit-analytics'];
  Object.assign(pj, {
    name: NAME,
    version: VERSION,
    description: 'Independent, maintained fork of the open-source realm-js SDK v20 (Apache-2.0, local database) for current React Native, Expo and Xcode. Not affiliated with MongoDB, Inc.',
    homepage: 'https://github.com/FirasHmedi/keelstore',
    repository: { type: 'git', url: 'git+https://github.com/FirasHmedi/keelstore.git' },
    bugs: { url: 'https://github.com/FirasHmedi/keelstore/issues' },
    keelstore: { upstream: `${UPSTREAM.name}@${UPSTREAM.version}`, upstreamIntegrity: meta.dist.integrity },
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
    const buf = await download(NODE_URL(t), join(CACHE, 'node', `${t}.tar.gz`));
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
        return require("#realm.node");
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

  // 4b. v20 has no Device Sync: REALM_ENABLE_SYNC=1 is a leftover that no shipped header or binding source reads
  patch(
    join(pkg, 'RealmJS.podspec'),
    "'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) REALM_ENABLE_SYNC=1',",
    "'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited)', # Modified by Pomwik, 2026: REALM_ENABLE_SYNC=1 removed (no sync in v20, read by nothing)",
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
    // The upstream 3.3.1 archive is still fetched: build-openssl.sh reuses its include.cmake
    await download(UPSTREAM_OPENSSL_URL(arch), join(CACHE, 'openssl', `openssl-${UPSTREAM_OPENSSL}-${arch}-android.tar.gz`));
    const name = `openssl-${OPENSSL}-${arch}-android.tar.gz`;
    const built = join(CACHE, 'openssl', name);
    if (!existsSync(built)) throw new Error(`${built} missing: run bridge/openssl/build-openssl.sh ${OPENSSL}`);
    // Inside a function, CMAKE_CURRENT_LIST_DIR is the caller's folder: record this file's folder when it is included
    patch(
      join(pkg, 'prebuilds/android', abi, 'share/cmake/Realm/AcquireRealmDependency.cmake'),
      'function(realm_acquire_dependency dep_name dep_version out_dep_cmake)',
      `# ${MARK}: folder of the OpenSSL archives shipped in the package
set(KEEL_BUNDLED_DEPS_DIR "\${CMAKE_CURRENT_LIST_DIR}/../../../deps")

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
    patch(
      join(pkg, 'prebuilds/android', abi, 'share/cmake/Realm/AcquireRealmDependency.cmake'),
      `        set(DEP_URL "https://static.realm.io/downloads/dependencies/\${dep_name}/\${dep_version}/\${dep_name}-\${dep_version}-\${_target_architecture_\${CMAKE_SYSTEM_NAME}_\${_target_architecture}}-\${_target_platform_name_\${CMAKE_SYSTEM_NAME}}.tar.gz")
        message(STATUS "Getting \${DEP_URL}...")
        file(DOWNLOAD "\${DEP_URL}" "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}/\${dep_name}.tar.gz" STATUS download_status)

        list(GET download_status 0 status_code)
        if (NOT "\${status_code}" STREQUAL "0")
            message(FATAL_ERROR "Downloading \${url}... Failed. Status: \${download_status}")
        endif()
`,
      `        # ${MARK}: use the copy shipped in the package, download only as a fallback
        set(DEP_FILE_NAME "\${dep_name}-\${dep_version}-\${_target_architecture_\${CMAKE_SYSTEM_NAME}_\${_target_architecture}}-\${_target_platform_name_\${CMAKE_SYSTEM_NAME}}.tar.gz")
        set(DEP_LOCAL "\${KEEL_BUNDLED_DEPS_DIR}/\${DEP_FILE_NAME}")
        if(EXISTS "\${DEP_LOCAL}")
            message(STATUS "Using bundled \${DEP_LOCAL}")
            file(MAKE_DIRECTORY "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}")
            file(COPY_FILE "\${DEP_LOCAL}" "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}/\${dep_name}.tar.gz" RESULT copy_result)
            if(NOT copy_result STREQUAL "0")
                message(FATAL_ERROR "Copying \${DEP_LOCAL} failed: \${copy_result}")
            endif()
        else()
            set(DEP_URL "https://static.realm.io/downloads/dependencies/\${dep_name}/\${dep_version}/\${DEP_FILE_NAME}")
            message(STATUS "Getting \${DEP_URL}...")
            file(DOWNLOAD "\${DEP_URL}" "\${CMAKE_CURRENT_BINARY_DIR}/\${dep_name}/\${dep_name}.tar.gz" STATUS download_status)
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
