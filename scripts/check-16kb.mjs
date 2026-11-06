#!/usr/bin/env node
// Checks that every 64-bit native library (.so) in an APK or AAB has all its PT_LOAD segments aligned on at least
// 16 KB, which Google Play requires for app updates from 1 February 2027. 32-bit ABIs (armeabi-v7a, x86) run on
// 4 KB pages and are only reported, unless --all. Reads the ELF program headers directly.
//
// Usage: node scripts/check-16kb.mjs <app.apk|app.aab|dir-with-.so-files> [--all]
// Exit code 1 if a required library is not aligned.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export const PAGE = 16384;
const ABI_32 = /(^|\/)(armeabi-v7a|x86)\//;
const PT_LOAD = 1;

/** Smallest p_align of the PT_LOAD segments of an ELF file (32 or 64 bits, little or big endian). */
export function loadAlignment(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file');
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const phoff = is64 ? u64(0x20) : u32(0x1c);
  const phentsize = u16(is64 ? 0x36 : 0x2a);
  const phnum = u16(is64 ? 0x38 : 0x2c);
  let min = Infinity;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (u32(p) !== PT_LOAD) continue;
    const align = is64 ? u64(p + 0x30) : u32(p + 0x1c);
    min = Math.min(min, align);
  }
  return min;
}

function soFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? soFiles(p) : e.name.endsWith('.so') ? [p] : [];
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/check-16kb.mjs <app.apk|app.aab|dir>');
    process.exit(2);
  }
  let dir = input;
  if (statSync(input).isFile()) {
    dir = mkdtempSync(join(tmpdir(), 'check16k-'));
    execFileSync('unzip', ['-q', '-o', input, '*.so', '-d', dir]);
  }
  const files = soFiles(dir);
  if (!files.length) {
    console.error(`No .so file found in ${input}`);
    process.exit(2);
  }
  const all = process.argv.includes('--all');
  let bad = 0;
  let required = 0;
  for (const f of files) {
    const rel = relative(dir, f);
    const optional = !all && ABI_32.test(rel);
    const align = loadAlignment(readFileSync(f));
    const ok = align >= PAGE;
    if (!optional) required++;
    if (!ok && !optional) bad++;
    console.log(`${ok ? 'OK  ' : optional ? 'info' : 'FAIL'} ${String(align).padStart(6)}  ${rel}`);
  }
  console.log(bad ? `\n${bad} of ${required} required libraries are not 16 KB aligned` : `\nAll ${required} 64-bit libraries are 16 KB aligned (${files.length - required} 32-bit libraries reported only)`);
  process.exit(bad ? 1 : 0);
}
