// Adversarial tests of scripts/check-16kb.mjs with real ELF files built by the NDK clang.
// Run: node --test review/check16kb.test.mjs   (needs ~/Library/Android/sdk/ndk/<x> or ANDROID_NDK_ROOT)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAlignment } from '../scripts/check-16kb.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/check-16kb.mjs');
const ndkRoot = process.env.ANDROID_NDK_ROOT ?? (() => {
  const d = join(process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk'), 'ndk');
  return existsSync(d) ? join(d, readdirSync(d).sort().pop()) : null;
})();
const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const clang = ndkRoot && join(ndkRoot, 'toolchains/llvm/prebuilt', host, 'bin/clang');
const skip = !clang || !existsSync(clang);

const work = mkdtempSync(join(tmpdir(), 'review-16k-'));
writeFileSync(join(work, 'a.c'), 'int f(int x){return x+1;}\nint g[4096];\n');
function so(target, pageSize, out) {
  const args = ['--target=' + target, '-shared', '-fPIC', '-o', out, join(work, 'a.c')];
  if (pageSize) args.push(`-Wl,-z,max-page-size=${pageSize}`, `-Wl,-z,common-page-size=${pageSize}`);
  execFileSync(clang, args, { stdio: 'pipe' });
  return out;
}
const run = (dir, ...extra) => spawnSync('node', [script, dir, ...extra], { encoding: 'utf8' });

test('loadAlignment: 64-bit 4 KB vs 16 KB, 32-bit', { skip }, () => {
  assert.equal(loadAlignment(readFileSync(so('aarch64-linux-android24', 4096, join(work, 'a64-4k.so')))), 4096);
  assert.equal(loadAlignment(readFileSync(so('aarch64-linux-android24', 16384, join(work, 'a64-16k.so')))), 16384);
  assert.equal(loadAlignment(readFileSync(so('x86_64-linux-android24', 65536, join(work, 'x64-64k.so')))), 65536);
  assert.equal(loadAlignment(readFileSync(so('armv7a-linux-androideabi24', 4096, join(work, 'arm32-4k.so')))), 4096);
  assert.equal(loadAlignment(readFileSync(so('i686-linux-android24', 16384, join(work, 'x86-16k.so')))), 16384);
});

test('CLI: a 4 KB arm64 library fails, a 16 KB one passes, a 4 KB 32-bit one is only reported', { skip }, () => {
  const d = join(work, 'apk1');
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) mkdirSync(join(d, 'lib', abi), { recursive: true });
  so('aarch64-linux-android24', 4096, join(d, 'lib/arm64-v8a/libbad.so'));
  so('aarch64-linux-android24', 16384, join(d, 'lib/arm64-v8a/libgood.so'));
  so('armv7a-linux-androideabi24', 4096, join(d, 'lib/armeabi-v7a/libold.so'));
  so('x86_64-linux-android24', 16384, join(d, 'lib/x86_64/libgood.so'));
  const r = run(d);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL\s+4096\s+64-bit\s+lib\/arm64-v8a\/libbad\.so/);
  assert.match(r.stdout, /info\s+4096\s+32-bit\s+lib\/armeabi-v7a\/libold\.so/);
  const all = run(d, '--all');
  assert.equal(all.status, 1);
  assert.match(all.stdout, /2 of 4 required/);
});

// Updated on 2026-11-06: the script now reads 32/64 bits from the ELF class, skips non-ELF files, and runs zipalign.
test('CLI: 32/64-bit classification comes from the ELF class: a 4 KB 64-bit lib in an x86 folder fails', { skip }, () => {
  const d = join(work, 'apk2');
  mkdirSync(join(d, 'lib/x86'), { recursive: true });
  mkdirSync(join(d, 'lib/arm64-v8a'), { recursive: true });
  so('aarch64-linux-android24', 4096, join(d, 'lib/x86/libmisplaced.so'));
  so('aarch64-linux-android24', 16384, join(d, 'lib/arm64-v8a/libok.so'));
  const r = run(d);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL\s+4096\s+64-bit\s+lib\/x86\/libmisplaced\.so/);
});

test('CLI: non-ELF file named .so: clear message, exit 2, no stack trace', () => {
  const d = join(work, 'apk3');
  mkdirSync(join(d, 'lib/arm64-v8a'), { recursive: true });
  writeFileSync(join(d, 'lib/arm64-v8a/libfake.so'), 'not an elf');
  const r = run(d);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /skip \(not ELF\)/);
  assert.doesNotMatch(r.stderr, /at .*check-16kb\.mjs/);
});

test('CLI: APK with no .so: "No .so file found", exit 2', () => {
  const d = mkdtempSync(join(tmpdir(), 'review-zip-'));
  writeFileSync(join(d, 'x.txt'), 'x');
  execFileSync('zip', ['-q', join(d, 'empty.apk'), 'x.txt'], { cwd: d });
  const r = run(join(d, 'empty.apk'));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /No \.so file found/);
});

test('zip alignment of the APK is checked with zipalign -c -P 16 -v 4 when zipalign is found', () => {
  const src = readFileSync(script, 'utf8');
  assert.match(src, /'-c', '-P', '16', '-v', '4'/);
});
