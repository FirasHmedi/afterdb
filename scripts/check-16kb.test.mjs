// Tests of scripts/check-16kb.mjs with real ELF files built by the Android NDK clang.
// Run: node --test scripts/check-16kb.test.mjs
// The ELF tests are skipped if no NDK is found ($ANDROID_NDK_ROOT or ~/Library/Android/sdk/ndk/*), the zipalign
// tests if no build-tools zipalign is found.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { elfInfo, findZipalign } from './check-16kb.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-16kb.mjs');

function findClang() {
  const ndks = [];
  if (process.env.ANDROID_NDK_ROOT) ndks.push(process.env.ANDROID_NDK_ROOT);
  const base = join(homedir(), 'Library/Android/sdk/ndk');
  if (existsSync(base)) {
    const versions = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    ndks.push(...versions.map((v) => join(base, v)));
  }
  for (const ndk of ndks) {
    const prebuilt = join(ndk, 'toolchains/llvm/prebuilt');
    if (!existsSync(prebuilt)) continue;
    for (const host of readdirSync(prebuilt)) {
      const clang = join(prebuilt, host, 'bin/clang');
      if (existsSync(clang)) return clang;
    }
  }
  return null;
}

const clang = findClang();
const noNdk = clang ? false : 'Android NDK clang not found';
const zipalign = findZipalign();
const noZipalign = noNdk || (zipalign ? false : 'zipalign not found');

const work = mkdtempSync(join(tmpdir(), 'check16k-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
writeFileSync(join(work, 'a.c'), 'int f(int x) { return x + 1; }\nint g[4096];\n');

const A64 = 'aarch64-linux-android24';
const A32 = 'armv7a-linux-androideabi24';
function so(target, pageSize, out) {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(clang, [`--target=${target}`, '-shared', '-fPIC', `-Wl,-z,max-page-size=${pageSize}`, '-o', out, join(work, 'a.c')], {
    stdio: 'pipe',
  });
  return out;
}
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('elfInfo reads the ELF class and the PT_LOAD alignment', { skip: noNdk }, () => {
  assert.deepEqual(elfInfo(readFileSync(so(A64, 4096, join(work, 'e/a64-4k.so')))), { bits: 64, align: 4096 });
  assert.deepEqual(elfInfo(readFileSync(so(A64, 16384, join(work, 'e/a64-16k.so')))), { bits: 64, align: 16384 });
  assert.deepEqual(elfInfo(readFileSync(so(A32, 4096, join(work, 'e/a32-4k.so')))), { bits: 32, align: 4096 });
  assert.deepEqual(elfInfo(readFileSync(so(A32, 16384, join(work, 'e/a32-16k.so')))), { bits: 32, align: 16384 });
});

test('64-bit 4 KB fails, 64-bit 16 KB passes, 32-bit 4 KB is reported only', { skip: noNdk }, () => {
  const d = join(work, 'mixed');
  so(A64, 4096, join(d, 'lib/arm64-v8a/libbad.so'));
  so(A64, 16384, join(d, 'lib/arm64-v8a/libgood.so'));
  so(A32, 4096, join(d, 'lib/armeabi-v7a/libold.so'));
  so(A32, 16384, join(d, 'lib/armeabi-v7a/libnew.so'));
  const r = run(d);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL\s+4096\s+64-bit\s+lib\/arm64-v8a\/libbad\.so/);
  assert.match(r.stdout, /OK\s+16384\s+64-bit\s+lib\/arm64-v8a\/libgood\.so/);
  assert.match(r.stdout, /info\s+4096\s+32-bit\s+lib\/armeabi-v7a\/libold\.so/);
  assert.match(r.stdout, /OK\s+16384\s+32-bit\s+lib\/armeabi-v7a\/libnew\.so/);
  assert.match(r.stdout, /1 of 2 required libraries are not 16 KB aligned \(2 32-bit libraries reported only\)/);

  const all = run(d, '--all');
  assert.equal(all.status, 1);
  assert.match(all.stdout, /FAIL\s+4096\s+32-bit\s+lib\/armeabi-v7a\/libold\.so/);
  assert.match(all.stdout, /2 of 4 required/);
});

test('only aligned 64-bit libraries: exit 0', { skip: noNdk }, () => {
  const d = join(work, 'good');
  so(A64, 16384, join(d, 'lib/arm64-v8a/libgood.so'));
  so(A32, 4096, join(d, 'lib/armeabi-v7a/libold.so'));
  const r = run(d);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All 1 64-bit libraries are 16 KB aligned \(1 32-bit libraries reported only\)/);
});

test('32 or 64 bits comes from the ELF class, not the folder name', { skip: noNdk }, () => {
  const d = join(work, 'misplaced');
  so(A64, 4096, join(d, 'lib/x86/libmisplaced64.so'));
  so(A32, 4096, join(d, 'lib/arm64-v8a/libmisplaced32.so'));
  const r = run(d);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL\s+4096\s+64-bit\s+lib\/x86\/libmisplaced64\.so/);
  assert.match(r.stdout, /info\s+4096\s+32-bit\s+lib\/arm64-v8a\/libmisplaced32\.so/);
});

test('AAB: libraries are read from the zip, zipalign is not run', { skip: noNdk }, () => {
  const d = join(work, 'apk-src');
  so(A64, 4096, join(d, 'lib/arm64-v8a/libbad.so'));
  const apk = join(work, 'bad.aab');
  execFileSync('zip', ['-q', '-r', apk, 'lib'], { cwd: d });
  const r = run(apk);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL\s+4096\s+64-bit\s+lib\/arm64-v8a\/libbad\.so/);
});

test('APK: zipalign -P 16 is run and its result counts', { skip: noZipalign }, () => {
  const d = join(work, 'zip-src');
  so(A64, 16384, join(d, 'lib/arm64-v8a/libgood.so'));
  // Stored (uncompressed) .so: almost certainly not on a 16 KB boundary inside the zip.
  const stored = join(work, 'stored.apk');
  execFileSync('zip', ['-q', '-0', '-r', stored, 'lib'], { cwd: d });
  const r1 = run(stored);
  assert.match(r1.stdout, /All 1 64-bit libraries are 16 KB aligned/);
  assert.match(r1.stdout, /zipalign -c -P 16 -v 4: FAIL/);
  assert.equal(r1.status, 1);
  // The same APK after `zipalign -P 16`: passes.
  const aligned = join(work, 'aligned.apk');
  execFileSync(zipalign, ['-f', '-P', '16', '4', stored, aligned]);
  const r2 = run(aligned);
  assert.match(r2.stdout, /zipalign -c -P 16 -v 4: OK/);
  assert.equal(r2.status, 0, r2.stdout);
});

test('empty folder: "No .so file found", exit 2', () => {
  const d = join(work, 'empty');
  mkdirSync(d, { recursive: true });
  const r = run(d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No \.so file found/);
});

test('non-ELF and truncated files are skipped, not a stack trace', { skip: noNdk }, () => {
  const d = join(work, 'notelf');
  mkdirSync(join(d, 'lib/arm64-v8a'), { recursive: true });
  writeFileSync(join(d, 'lib/arm64-v8a/libfake.so'), 'not an elf');
  const full = readFileSync(so(A64, 16384, join(work, 'e/full.so')));
  writeFileSync(join(d, 'lib/arm64-v8a/libtruncated.so'), full.subarray(0, 0x40));
  copyFileSync(join(work, 'e/full.so'), join(d, 'lib/arm64-v8a/libgood.so'));
  const r = run(d);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /at .*check-16kb\.mjs/);
  assert.match(r.stdout, /skip \(not ELF\)\s+lib\/arm64-v8a\/libfake\.so/);
  assert.match(r.stdout, /skip \(not ELF\)\s+lib\/arm64-v8a\/libtruncated\.so/);
  assert.match(r.stdout, /2 skipped \(not ELF\)/);
});

test('non-ELF file alone: skipped, no stack trace', () => {
  const d = join(work, 'notelf-only');
  mkdirSync(join(d, 'lib/arm64-v8a'), { recursive: true });
  writeFileSync(join(d, 'lib/arm64-v8a/libfake.so'), 'not an elf');
  const r = run(d);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /skip \(not ELF\)\s+lib\/arm64-v8a\/libfake\.so/);
});

test('zip without .so: "No .so file found", exit 2', () => {
  const d = join(work, 'zip-empty');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'x.txt'), 'x');
  execFileSync('zip', ['-q', join(d, 'empty.apk'), 'x.txt'], { cwd: d });
  const r = run(join(d, 'empty.apk'));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /No \.so file found/);
  assert.doesNotMatch(r.stderr, /Command failed|at /);
});

test('missing input: exit 2 with a message', () => {
  const r = run(join(work, 'does-not-exist.apk'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Cannot read/);
});
