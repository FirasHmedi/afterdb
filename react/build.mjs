#!/usr/bin/env node
// Builds keelstore-react: the official @realm/react@0.20.0 npm tarball (Apache-2.0), verified by its npm
// integrity hash, with react-native as an optional peer dependency (realm/realm-js#7066).
//
// Usage: node react/build.mjs [--out react/out]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
export const UPSTREAM = { name: '@realm/react', version: '0.20.0' };
export const NAME = '@pomwik/keelstore-react';
export const VERSION = '0.20.1';
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(here, 'out');

export async function build() {
  const meta = await (await fetch(`https://registry.npmjs.org/${UPSTREAM.name.replace('/', '%2F')}/${UPSTREAM.version}`)).json();
  const cache = join(here, '.cache', 'realm-react.tgz');
  if (!existsSync(cache)) {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer()));
  }
  const [algo, b64] = meta.dist.integrity.split('-');
  if (createHash(algo).update(readFileSync(cache)).digest('base64') !== b64) throw new Error('Upstream tarball does not match its npm integrity hash');

  const work = join(out, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xzf', cache, '-C', work]);
  const pkg = join(work, 'package');

  const pj = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  if (!pj.optionalDependencies?.['react-native']) throw new Error('package.json: react-native is no longer an optional dependency upstream');
  const rn = pj.optionalDependencies['react-native'];
  delete pj.optionalDependencies['react-native'];
  if (!Object.keys(pj.optionalDependencies).length) delete pj.optionalDependencies;
  pj.peerDependencies = { ...pj.peerDependencies, 'react-native': rn, realm: '>=20.0.0' };
  pj.peerDependenciesMeta = { ...pj.peerDependenciesMeta, 'react-native': { optional: true } };
  Object.assign(pj, {
    name: NAME,
    version: VERSION,
    description: 'React hooks for keelstore (repackaged @realm/react 0.20.0). Not affiliated with MongoDB, Inc.',
    homepage: 'https://github.com/FirasHmedi/keelstore',
    repository: { type: 'git', url: 'git+https://github.com/FirasHmedi/keelstore.git' },
    keelstore: { upstream: `${UPSTREAM.name}@${UPSTREAM.version}`, upstreamIntegrity: meta.dist.integrity },
  });
  pj.files = [...(pj.files ?? []), 'LICENSE', 'NOTICE', 'CHANGES-FROM-UPSTREAM.md'];
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(pj, null, 2) + '\n');
  cpSync(join(root, 'LICENSE'), join(pkg, 'LICENSE'));
  cpSync(join(root, 'NOTICE'), join(pkg, 'NOTICE'));
  cpSync(join(root, 'CHANGES-FROM-UPSTREAM.md'), join(pkg, 'CHANGES-FROM-UPSTREAM.md'));
  writeFileSync(
    join(pkg, 'README.md'),
    '# @pomwik/keelstore-react\n\nThe `@realm/react` 0.20.0 hooks (RealmProvider, useQuery, useObject, useRealm), repackaged for @pomwik/keelstore.\nUse it through an npm alias: `"@realm/react": "npm:@pomwik/keelstore-react@0.20.1"`. Changes: see CHANGES-FROM-UPSTREAM.md.\n\nRealm® is a trademark of MongoDB, Inc. This project is independent and not affiliated with or endorsed by MongoDB. Licence: Apache-2.0.\n',
  );
  const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: pkg, encoding: 'utf8' }).trim().split('\n').pop();
  return { tarball: join(out, file), pkg };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log((await build()).tarball);
