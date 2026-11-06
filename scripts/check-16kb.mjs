#!/usr/bin/env node
// Checks that every 64-bit native library (.so) in an APK, an AAB or a folder has all its PT_LOAD segments aligned
// on at least 16 KB, which Google Play requires for app updates from 1 February 2027. 32-bit libraries (ELF class 1,
// armeabi-v7a and x86) run on 4 KB pages: they are only reported, unless --all. 32 or 64 bits is read from the ELF
// header (byte 4), not from the folder name. Files that are not ELF, or are truncated, are reported as skipped.
// For an .apk, if zipalign is found in the Android SDK build-tools, `zipalign -c -P 16 -v 4` is also run.
//
// Usage: node scripts/check-16kb.mjs <app.apk|app.aab|dir-with-.so-files> [--all]
// Exit code: 0 all required libraries aligned, 1 a required library (or the APK zip alignment) is not aligned,
// 2 usage error, unreadable input, or no .so file that is an ELF file.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGE = 16384;
const PT_LOAD = 1;

/**
 * Reads the ELF header and program headers. Returns { bits: 32 | 64, align } where align is the smallest p_align
 * of the PT_LOAD segments (Infinity if there is none). Throws if the buffer is not a complete ELF file.
 */
export function elfInfo(buf) {
  if (buf.length < 0x34 || buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file');
  const cls = buf[4];
  if (cls !== 1 && cls !== 2) throw new Error(`unknown ELF class ${cls}`);
  const is64 = cls === 2;
  if (buf[5] !== 1 && buf[5] !== 2) throw new Error(`unknown ELF data encoding ${buf[5]}`);
  const le = buf[5] === 1;
  // Buffer read methods throw a RangeError on a truncated file.
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const phoff = is64 ? u64(0x20) : u32(0x1c);
  const phentsize = u16(is64 ? 0x36 : 0x2a);
  const phnum = u16(is64 ? 0x38 : 0x2c);
  let align = Infinity;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (u32(p) !== PT_LOAD) continue;
    align = Math.min(align, is64 ? u64(p + 0x30) : u32(p + 0x1c));
  }
  return { bits: is64 ? 64 : 32, align };
}

/** Smallest p_align of the PT_LOAD segments of an ELF file (32 or 64 bits, little or big endian). */
export function loadAlignment(buf) {
  return elfInfo(buf).align;
}

function soFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? soFiles(p) : e.name.endsWith('.so') ? [p] : [];
  });
}

/** Newest zipalign of the Android SDK build-tools, or null. */
export function findZipalign(env = process.env) {
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), 'Library/Android/sdk'), join(homedir(), 'Android/Sdk')];
  const exe = process.platform === 'win32' ? 'zipalign.exe' : 'zipalign';
  for (const sdk of sdks.filter(Boolean)) {
    const bt = join(sdk, 'build-tools');
    if (!existsSync(bt)) continue;
    const versions = readdirSync(bt).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) if (existsSync(join(bt, v, exe))) return join(bt, v, exe);
  }
  return null;
}

/** Runs the check and returns the exit code. */
export function main(args, log = console.log, err = console.error) {
  const input = args.find((a) => !a.startsWith('--'));
  const all = args.includes('--all');
  if (!input) {
    err('Usage: node scripts/check-16kb.mjs <app.apk|app.aab|dir> [--all]');
    return 2;
  }
  let stat;
  try {
    stat = statSync(input);
  } catch {
    err(`Cannot read ${input}`);
    return 2;
  }
  let dir = input;
  let tmp = null;
  if (stat.isFile()) {
    tmp = dir = mkdtempSync(join(tmpdir(), 'check16k-'));
    const r = spawnSync('unzip', ['-q', '-o', input, '*.so', '-d', dir], { encoding: 'utf8' });
    // unzip exits 11 when no entry matches the pattern.
    if (r.error || (r.status !== 0 && r.status !== 11)) {
      err(`Cannot unzip ${input}: ${r.error?.message ?? r.stderr.trim()}`);
      rmSync(tmp, { recursive: true, force: true });
      return 2;
    }
  }
  try {
    const files = soFiles(dir);
    if (!files.length) {
      err(`No .so file found in ${input}`);
      return 2;
    }
    let bad = 0;
    let required = 0;
    let skipped = 0;
    for (const f of files) {
      const rel = relative(dir, f);
      let info;
      try {
        info = elfInfo(readFileSync(f));
      } catch {
        skipped++;
        log(`skip (not ELF)  ${rel}`);
        continue;
      }
      const optional = !all && info.bits === 32;
      const ok = info.align >= PAGE;
      if (!optional) required++;
      if (!ok && !optional) bad++;
      const verdict = ok ? 'OK  ' : optional ? 'info' : 'FAIL';
      log(`${verdict} ${String(info.align).padStart(6)}  ${info.bits}-bit  ${rel}`);
    }
    if (skipped === files.length) {
      err(`No ELF .so file found in ${input}: nothing was checked`);
      return 2;
    }
    const reported = files.length - required - skipped;
    const extra = [!all && `${reported} 32-bit libraries reported only`, skipped && `${skipped} skipped (not ELF)`].filter(Boolean);
    const tail = extra.length ? ` (${extra.join(', ')})` : '';
    log(
      bad
        ? `\n${bad} of ${required} required libraries are not 16 KB aligned${tail}`
        : `\nAll ${required} ${all ? '' : '64-bit '}libraries are 16 KB aligned${tail}`,
    );

    let zipBad = false;
    if (stat.isFile() && input.toLowerCase().endsWith('.apk')) {
      const zipalign = findZipalign();
      if (zipalign) {
        const z = spawnSync(zipalign, ['-c', '-P', '16', '-v', '4', input], { encoding: 'utf8' });
        zipBad = z.status !== 0;
        const last = `${z.stdout ?? ''}${z.stderr ?? ''}`.trim().split('\n').pop().trim();
        log(`zipalign -c -P 16 -v 4: ${zipBad ? 'FAIL' : 'OK'}${last ? ` (${last})` : ''}`);
      }
    }
    return bad || zipBad ? 1 : 0;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
