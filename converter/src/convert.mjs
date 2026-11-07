// Convert a local object database file into a SQLite database, then verify it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Realm from 'realm';
import Database from 'better-sqlite3';
import { buildModel, ddl, q, isFloat, META_TABLE } from './model.mjs';
import { mergeAppSchema } from './schema.mjs';
import { scalarToSql, floatPair, keyToSql, embeddedToJson, collectionToJson } from './values.mjs';
import { verify } from './verify.mjs';
import { relax, due, pause } from './gc.mjs';
import { toMarkdown, sourceChange } from './report.mjs';
import { indexClasses } from './sdk.mjs';
import { SQLITE_SIDE, statOf, lstatOf, sameFile, canonical, within, foldName, Created, createUnique, privateCopy, commitName, modeFrom, keepNarrowerMode } from './files.mjs';

export const TOOL_VERSION = '0.1.0';
export { removeCreatedFiles } from './files.mjs';
export { sourceChange } from './report.mjs';

/** SHA-256 of a file, or of its first `length` bytes. */
export async function fileSha256(file, length) {
  const h = createHash('sha256');
  const opts = length === undefined ? {} : { start: 0, end: length - 1 };
  if (length !== 0) for await (const chunk of fs.createReadStream(file, opts)) h.update(chunk);
  return h.digest('hex');
}

export function parseKey(hex) {
  if (!hex) return undefined;
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) throw new Error('--key must be 128 hex characters (64 bytes)');
  return Buffer.from(hex, 'hex');
}

/** Load an app schema module: default export or `schema` export, array of schemas or classes. */
export async function loadSchema(file) {
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const s = mod.schema ?? mod.default;
  if (!Array.isArray(s)) throw new Error(`${file}: export an array named "schema" or a default array`);
  return s;
}

// Files an app keeps next to a realm file it opens. The tool never opens the
// source with the SDK (it converts a private copy, see convert()), so it
// creates none of them next to the source, and it never deletes them: they
// belong to the app, which may open the file while a conversion runs (deleted,
// they would let a second writer change the file while the app writes to it,
// and a committed write could be lost). They are still checked against every
// path the run writes: the app creates them when it opens the file, and would
// then overwrite the output.
const AUX = ['.lock', '.note', '.management', '.fresh.lock', '.log', '.log_a', '.log_b'];

/**
 * Opens a realm file read-only, without a schema: the SDK then exposes exactly
 * the classes and properties stored in the file. Only used on the private copy
 * of the input: a read-only open maps the file without the writers' lock, and
 * realm-core crashes (SIGSEGV, SIGABRT in alloc.hpp, SIGBUS) when another
 * process writes to the file meanwhile.
 */
async function openRealm(file, { key }) {
  const config = { path: file, readOnly: true };
  if (key) config.encryptionKey = key;
  const realm = await Realm.open(config);
  try {
    indexClasses(realm);
  } catch (e) {
    realm.close();
    throw e;
  }
  return realm;
}

/**
 * The files an app uses next to the input, in canonical form: next to the file
 * as the system resolves it (`source`), and next to the name as given when it
 * differs (a link to the file: the app may open the link).
 */
function sdkFiles(source, input) {
  const places = [];
  for (const [dir, base] of [[path.dirname(source), path.basename(source)], [canonical(path.dirname(input)), path.basename(input)]]) {
    const file = path.join(dir, base);
    if (places.some((pl) => pl.file === file)) continue;
    places.push({ file, dir, files: AUX.map((s) => ({ name: file + s, fold: foldName(base + s) })) });
  }
  return places;
}

/** Paths of the input and of the files an app uses next to it (see sdkFiles). */
const sourceFiles = (source, sdk) => [source, ...sdk.flatMap((pl) => pl.files.map((f) => f.name))];

/**
 * The SDK file of the input that `p` is or is inside, or null. By name,
 * ignoring case and Unicode normalization: on a case-insensitive disk
 * `app.realm.Lock` is `app.realm.lock`, and the SDK creates it (and would then
 * overwrite our output) even when it does not exist yet. Names that differ only
 * in case are refused on a case-sensitive disk too. Also by inode (links).
 */
function sdkFileAt(p, sdk) {
  const c = canonical(p);
  for (const pl of sdk) {
    if (within(c, pl.dir) && c !== pl.dir) {
      const first = foldName(path.relative(pl.dir, c).split(path.sep)[0]);
      const hit = pl.files.find((f) => f.fold === first);
      if (hit) return hit.name;
    }
  }
  const s = statOf(p);
  if (s) for (const pl of sdk) for (const f of pl.files) if (sameFile(s, statOf(f.name))) return f.name;
  return null;
}

/** True when the disk refuses the name (or the path) as too long. */
function tooLong(p) {
  try {
    fs.lstatSync(p);
  } catch (e) {
    return e.code === 'ENAMETOOLONG';
  }
  return false;
}

const REPORT_FILES = ['report.json', 'report.md'];

/**
 * The output path as the system resolves it: its folder resolved (links, and
 * `sub/..` where sub is a link), its name as given (a link at <out> is <out>).
 * The run creates, checks and reports this path.
 */
function resolveOutput(output) {
  if (typeof output !== 'string' || output === '') throw new Error('output path required');
  if (output.endsWith('/') || output.endsWith(path.sep) || ['.', '..'].includes(path.basename(output))) throw new Error(`${output} is a folder name; give a file name for the output`);
  const dir = path.dirname(output);
  if (!statOf(dir)?.isDirectory()) throw new Error(`output folder not found: ${dir === '.' ? process.cwd() : dir}`);
  const out = path.join(fs.realpathSync.native(dir), path.basename(output));
  // SQLite needs <out>-journal next to the database (8 bytes more than <out>).
  if (tooLong(output) || tooLong(output + '-journal') || tooLong(out + '-journal')) {
    throw new Error(`output name too long for this disk: ${Buffer.byteLength(path.basename(output))} bytes; SQLite needs <name>-journal ` +
      'next to the database, 8 bytes more (most disks allow 255 bytes per name, so at most 247)');
  }
  return out;
}

/**
 * Checks, before any work, every path the run may create, replace or delete
 * (`output` and `report` as the system resolves them, see resolveOutput()):
 * - SQLite files: <out> and <out>.failed, each with its side files -journal,
 *   -wal and -shm (SQLite applies or deletes them when it opens the database);
 * - the report folder and report.json / report.md in it.
 * None may be the input or one of the files an app keeps next to it, and the
 * report may not overlap the SQLite files. <out> may not be a folder, may only
 * be replaced with --force, and may not have side files of its own (an old
 * hot journal would be applied to the new file). <out>.failed is only needed
 * when verification fails; it is checked at that point (checkTarget).
 * The temporary file and the folder of the copy get unique names and are
 * created exclusively, so they cannot be any existing file.
 */
function checkPaths(source, output, report, sdk, opts) {
  const src = statOf(source);
  if (report !== undefined && tooLong(path.join(report, '.report.json.000000000000.tmp'))) throw new Error(`--report folder name too long for this disk: ${report}`);

  const sqlite = [output, output + '.failed'].flatMap((f) => [f, ...SQLITE_SIDE.map((s) => f + s)]);
  const reportFiles = report === undefined ? [] : REPORT_FILES.map((f) => path.join(report, f));
  const written = [...sqlite, ...(report === undefined ? [] : [report]), ...reportFiles];
  for (const p of written) {
    const isInput = sameFile(statOf(p), src) || within(canonical(p), source);
    const aux = isInput ? null : sdkFileAt(p, sdk);
    if (isInput || aux) {
      const what = isInput ? 'the input file' : `a file the SDK uses next to the input (${aux}; names that differ only in case are the same file on most disks)`;
      throw new Error(`${p} is ${what}; choose another ${p === report || reportFiles.includes(p) ? 'report folder' : 'output name'}`);
    }
  }

  if (statOf(output)?.isDirectory()) throw new Error(`${output} is a folder; give a file name for the output`);
  // lstat: a link (even a dangling one) at <out> is an existing output.
  if (lstatOf(output) && !opts.force) throw new Error(`output exists: ${output} (use --force)`);
  for (const s of SQLITE_SIDE) {
    if (lstatOf(output + s)) {
      throw new Error(`${output + s} exists: SQLite would apply it to the new ${path.basename(output)}. ` +
        'It belongs to an old database or to a program that has it open; close that program or remove the file, or choose another output name');
    }
  }

  if (report !== undefined) {
    // The folder, or the nearest existing folder above it (created at the end).
    let p = report;
    while (!lstatOf(p) && path.dirname(p) !== p) p = path.dirname(p);
    if (!statOf(p)?.isDirectory()) throw new Error(`--report must be a folder: ${report}${p !== report ? ` (${p} is not a folder)` : ''}`);
    try { fs.accessSync(p, fs.constants.W_OK | fs.constants.X_OK); } catch { throw new Error(`--report folder is not writable: ${p}`); }
    const repCanon = canonical(report);
    const sqliteCanon = sqlite.map(canonical);
    const sqliteStat = sqlite.map(statOf);
    for (const [i, o] of sqlite.entries()) {
      if (within(repCanon, sqliteCanon[i])) {
        throw new Error(`--report ${report} ${repCanon === sqliteCanon[i] ? 'is' : 'is inside'} ${o}, which the conversion writes; choose another report folder`);
      }
    }
    for (const f of reportFiles) {
      const c = canonical(f);
      const s = statOf(f);
      for (const [i, o] of sqlite.entries()) {
        if (c === sqliteCanon[i] || sameFile(s, sqliteStat[i])) {
          throw new Error(`report file ${f} is ${f === o ? 'the path of ' : ''}${o}, which the conversion writes; choose another report folder or output name`);
        }
      }
      if (s?.isDirectory()) throw new Error(`${f} is a folder; the report cannot be written`);
      if (s) {
        try { fs.accessSync(f, fs.constants.W_OK); } catch { throw new Error(`${f} is read-only; remove it or choose another report folder`); }
      }
    }
  }
  return src;
}

/** Row values for one object, in model column order. */
function rowOf(model, t, obj, stats) {
  const row = [];
  if (t.key.synthetic) row.push(keyToSql(model, t.name, obj));
  for (const [n, d] of Object.entries(t.props)) {
    const v = obj[n];
    if (d.kind === 'scalar') {
      if (isFloat(d.type)) {
        if (v !== null && v !== undefined && (Number.isNaN(v) || Object.is(v, -0) || !Number.isFinite(v))) stats.special++;
        row.push(...floatPair(v));
      } else {
        const s = scalarToSql(d.type, v);
        if (d.type === 'int' && typeof s === 'number' && !Number.isSafeInteger(s)) stats.unsafeInt++;
        row.push(s);
      }
    } else if (d.kind === 'link') {
      row.push(v ? keyToSql(model, d.target, v) : null);
    } else if (d.kind === 'embedded') {
      const j = d.many ? Array.from(v, (e) => embeddedToJson(model, d.target, e)) : embeddedToJson(model, d.target, v);
      row.push(j === null ? null : JSON.stringify(j));
    } else if (d.kind === 'json') {
      const j = collectionToJson(model, d, v);
      row.push(j === null ? null : JSON.stringify(j));
    }
  }
  return row;
}

/** Write the SQLite file at `file` and verify it against the open source. */
async function build(realm, file, { schema, shaBefore, batchSize, sample, seed, warnings, timings, sampleRss, beforeVerify }) {
  let t;
  const db = new Database(file);
  try {
    let source = realm.schema;
    if (schema) {
      const m = mergeAppSchema(realm.schema, schema);
      source = m.schema;
      warnings.push(...m.warnings);
    } else {
      warnings.push('No app schema given (--schema): backlinks (linkingObjects) are not stored in the file and are not converted.');
    }
    const { model, warnings: mw } = buildModel(source);
    warnings.push(...mw);
    // The query translator then knows every name the app's SDK accepts
    // (backlinks, public mapTo names): see translate() in rql.mjs.
    if (schema) model.appSchema = true;
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('foreign_keys = OFF');
    const { tables, after } = ddl(model);
    db.exec(tables.join('\n'));

    // Load, class by class, in batches.
    t = performance.now();
    const stats = { special: 0, unsafeInt: 0 };
    const loadCounts = {};
    let sinceGc = 0;
    for (const tm of Object.values(model.classes)) {
      const cols = tm.columns.map((c) => q(c.name));
      const ins = db.prepare(`INSERT INTO ${q(tm.table)} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      const listIns = {};
      for (const l of tm.lists) {
        const lc = l.columns.map((c) => q(c.name));
        listIns[l.prop] = db.prepare(`INSERT INTO ${q(l.table)} (${lc.join(',')}) VALUES (${lc.map(() => '?').join(',')})`);
      }
      const results = realm.objects(tm.name);
      const n = results.length;
      const insertOne = (obj) => {
        ins.run(rowOf(model, tm, obj, stats));
        if (tm.lists.length === 0) return;
        const owner = keyToSql(model, tm.name, obj);
        for (const l of tm.lists) {
          const d = tm.props[l.prop];
          let pos = 0;
          for (const e of obj[l.prop]) {
            if (d.elem.type === 'object') listIns[l.prop].run(owner, pos++, keyToSql(model, d.elem.target, e));
            else if (isFloat(d.elem.type)) listIns[l.prop].run(owner, pos++, ...floatPair(e));
            else listIns[l.prop].run(owner, pos++, scalarToSql(d.elem.type, e));
          }
        }
      };
      // One transaction per batch. Inside it the loop still yields (time slices
      // for signals, a GC every 10 000 objects), so a large --batch does not
      // block the event loop; nothing else uses this connection meanwhile.
      for (let i = 0; i < n; i += batchSize) {
        const to = Math.min(n, i + batchSize);
        db.exec('BEGIN');
        try {
          for (let j = i; j < to; j++) {
            insertOne(results[j]);
            if (++sinceGc === 10000) { sinceGc = 0; sampleRss(); await relax(); }
            else if (due()) await pause();
          }
          db.exec('COMMIT');
        } catch (e) {
          if (db.inTransaction) db.exec('ROLLBACK');
          throw e;
        }
      }
      loadCounts[tm.name] = n;
      await relax();
    }
    sampleRss();
    timings.loadMs = performance.now() - t;
    if (stats.special) warnings.push(`${stats.special} double/float value(s) are NaN, -0 or ±Infinity: kept via the "<column>__x" companion column (NaN, -0); Infinity is native REAL.`);
    if (stats.unsafeInt) warnings.push(`${stats.unsafeInt} int value(s) exceed 2^53: the JS SDK already reads them rounded; stored as read.`);

    t = performance.now();
    for (const stmt of after) {
      db.exec(stmt);
      if (due()) await pause();
    }
    const meta = db.prepare(`INSERT INTO ${q(META_TABLE)} VALUES (?, ?)`);
    meta.run('model', JSON.stringify(model));
    meta.run('renames', JSON.stringify(model.renames));
    meta.run('tool', `@pomwik/afterdb-convert ${TOOL_VERSION}`);
    meta.run('source_sha256', shaBefore);
    timings.indexMs = performance.now() - t;

    if (beforeVerify) beforeVerify(db); // test hook
    t = performance.now();
    const verification = await verify(realm, db, model, { sample, seed });
    sampleRss();
    timings.verifyMs = performance.now() - t;
    db.pragma('journal_mode = DELETE');
    return { model, verification, loadCounts };
  } finally {
    db.close();
  }
}

/**
 * Last checks of a path just before the run renames one of its files onto it.
 * The up-front checks (checkPaths) can miss two names that differ only in case
 * and do not exist yet, and things can change during the run. `sources`: the
 * input and the SDK files next to it, which exist by now.
 */
function checkTarget(p, sources, others, { failed = false, force = true } = {}) {
  const s = statOf(p);
  if (s?.isDirectory()) throw new Error(failed ? `verification failed, and ${p} is a folder: the failed output cannot be kept there` : `${p} is a folder; give a file name for the output`);
  for (const [i, f] of sources.entries()) {
    if (sameFile(s, statOf(f))) throw new Error(`${p} is ${i === 0 ? 'the input file' : `a file the SDK uses next to the input (${f})`}; choose another output name`);
  }
  for (const o of others) if (sameFile(s, statOf(o))) throw new Error(`${p} is ${o}, written by this run; choose other names`);
  if (!force && lstatOf(p)) throw new Error(`output exists: ${p} (created during the conversion; use --force)`);
}

/**
 * The source at the end of the run, compared with the file that was copied
 * (SHA-256 `sha`, `bytes` long). `state`: 'unchanged'; 'changed' (another
 * program wrote to it or replaced it, smaller files included: a compaction
 * writes a new file); 'truncated' (the same file, cut short: what is left is
 * the start of the copy); 'deleted' (nothing at its path any more: deleted or
 * moved); 'unreadable' (there, but it cannot be read).
 * `copy`: the private copy (still there); `copied`: stat of the source taken
 * before the copy (same file = same device and inode).
 */
export async function sourceAtEnd(source, sha, bytes, { copy, copied } = {}) {
  let s;
  try {
    s = statOf(source);
  } catch (e) {
    return { state: 'unreadable', sha256: null, bytes: null, error: e.code ?? e.message };
  }
  if (!s) return { state: 'deleted', sha256: null, bytes: null };
  let sha256;
  try {
    sha256 = await fileSha256(source);
  } catch (e) {
    return { state: statOf(source) ? 'unreadable' : 'deleted', sha256: null, bytes: null, error: e.code ?? e.message };
  }
  const now = Number(s.size);
  let state = sha256 === sha ? 'unchanged' : 'changed';
  if (state === 'changed' && now < bytes && copy && sameFile(s, copied)) {
    try {
      if ((await fileSha256(copy, now)) === sha256) state = 'truncated';
    } catch { /* the copy cannot be read: 'changed' */ }
  }
  return { state, sha256, bytes: now };
}

function checkSqliteTarget(p, failed) {
  for (const s of SQLITE_SIDE) {
    if (lstatOf(p + s)) {
      throw new Error(`${failed ? 'verification failed, and ' : ''}${p + s} exists: SQLite would apply it to the new ${path.basename(p)}; remove it or choose another output name`);
    }
  }
}

export async function convert(input, output, opts = {}) {
  const t0 = performance.now();
  const timings = {};
  const warnings = [];
  const batchSize = opts.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`batch size must be a whole number of at least 1, got ${opts.batchSize}`);
  const sample = opts.sample ?? 300;
  if (!Number.isInteger(sample) || sample < 0) throw new Error(`sample size must be a whole number of at least 0, got ${opts.sample}`);
  const key = typeof opts.key === 'string' ? parseKey(opts.key) : opts.key;
  const schema = typeof opts.schema === 'string' ? await loadSchema(opts.schema) : opts.schema;
  let peakRss = process.memoryUsage().rss;
  const sampleRss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };

  const inStat = typeof input === 'string' && input !== '' ? statOf(input) : null;
  if (!inStat) throw new Error(`input not found: ${input}`);
  if (!inStat.isFile()) throw new Error(`input is not a file: ${input}`);
  // The input as the system resolves it (links, and "docs/.." where docs is a
  // link): the file that is hashed, copied and named in the report.
  const source = fs.realpathSync.native(input);
  // opts.report: a folder name, or undefined / null / false for no report.
  const reportDir = opts.report === undefined || opts.report === null || opts.report === false ? undefined : opts.report;
  if (reportDir !== undefined && (typeof reportDir !== 'string' || reportDir === '')) {
    throw new Error(`report must be a folder name (a non-empty string), or false for no report; got ${JSON.stringify(opts.report) ?? String(opts.report)}`);
  }
  // From here on, the output and the report as the system resolves them.
  const out = resolveOutput(output);
  const rep = reportDir === undefined ? undefined : canonical(reportDir);
  const sdk = sdkFiles(source, input);
  const src = checkPaths(source, out, rep, sdk, opts);

  // From here on, every file or folder the run creates is recorded, and removed
  // again if the run ends with an error (or is interrupted, see bin/).
  const created = new Created();
  try {
    // A short name in the folder of <out> (not <out>.<random>.partial): any
    // <out> that leaves room for <out>-journal works. The database and the
    // report are no more open than the input (a plaintext copy of an encrypted
    // 0600 file stays 0600).
    const mode = modeFrom(src.mode);
    const partial = createUnique(path.join(path.dirname(out), 'afterdb'), '.partial', created, { sqlite: true, mode });

    // The SDK never opens the input: if an app writes to a file the SDK has open
    // read-only, realm-core can crash the process. The run converts a private
    // copy instead, and only a copy of the file as it was: SHA-256 of the input
    // before the copy = SHA-256 of the copy = SHA-256 of the input after it.
    // The file as it is before the copy: sourceAtEnd() tells a file cut short
    // (same file) from one replaced by a smaller one.
    const copied = statOf(source);
    let t = performance.now();
    const shaBefore = await fileSha256(source);
    timings.hashBeforeMs = performance.now() - t;
    t = performance.now();
    let copy;
    try {
      copy = await privateCopy(source, path.dirname(out), created);
    } catch (e) {
      e.message = `cannot copy the input into the output folder (${path.dirname(out)}; it needs free space for a whole copy of the input): ${e.message}`;
      throw e;
    }
    if (opts._afterCopy) await opts._afterCopy(copy); // test hook
    const shaCopy = await fileSha256(copy);
    timings.copyMs = performance.now() - t;
    t = performance.now();
    const shaAfterCopy = await fileSha256(source);
    timings.hashAfterCopyMs = performance.now() - t;
    if (shaCopy !== shaBefore || shaAfterCopy !== shaBefore) throw new Error(`the file changed while it was copied: close the app, or pull a copy of the file first (${input})`);
    const copiedAt = new Date().toISOString();
    const inputSize = fs.statSync(copy).size;
    if (opts._afterSnapshot) await opts._afterSnapshot(copy); // test hook: the copy is checked

    t = performance.now();
    let realm;
    try {
      realm = await openRealm(copy, { key });
    } catch (e) {
      // The SDK names the private copy, which is deleted when the message is read.
      if (typeof e?.message === 'string') e.message = e.message.split(copy).join(source);
      throw e;
    }
    timings.openMs = performance.now() - t;
    let result;
    try {
      result = await build(realm, partial, { schema, shaBefore, batchSize, sample, seed: opts.seed ?? 1, warnings, timings, sampleRss, beforeVerify: opts._beforeVerify });
    } finally {
      realm.close();
    }

    // The bytes the SDK read did not change during the run.
    t = performance.now();
    const shaEnd = await fileSha256(copy);
    timings.hashCopyMs = performance.now() - t;
    // Only a verified file gets the final name (replacing any old one). A failed
    // one is kept as <out>.failed for inspection, so it cannot be shipped by mistake.
    const ok = shaEnd === shaBefore && result.verification.ok;
    const final = ok ? out : out + '.failed';
    if (!ok) warnings.push(`Verification failed: output kept as ${final}; ${out} was not written.`);
    // The source itself, hashed again at the end of the run: another program
    // may have written to it, truncated, replaced or deleted it after the copy.
    // The output is then a snapshot of the copy, not of the file as it is now;
    // the run still ends with exit 0 when it is verified (README, Exit code).
    t = performance.now();
    const end = await sourceAtEnd(source, shaBefore, inputSize, { copy, copied });
    timings.hashAfterMs = performance.now() - t;
    const unchanged = end.state === 'unchanged';
    if (!unchanged) {
      const change = sourceChange({ atEnd: end.state, bytes: inputSize, bytesAfter: end.bytes, copiedAt }, ok);
      warnings.push(`Source unchanged: false: ${change}, not of the file as it is now. Close the app and convert again for the current data.`);
    }
    timings.totalMs = performance.now() - t0;
    sampleRss();

    const report = {
      tool: `@pomwik/afterdb-convert ${TOOL_VERSION}`,
      createdAt: new Date().toISOString(),
      // sha256Before: before the copy; sha256AfterCopy: right after it (equal,
      // or the run stops); sha256After, bytesAfter: at the end of the run (null
      // when the file could not be read then). unchanged: sha256After =
      // sha256Before; atEnd: unchanged, changed, truncated, deleted or
      // unreadable (see sourceAtEnd). When unchanged is false, the output is a
      // snapshot of the copy taken at copiedAt (snapshot: true).
      input: {
        path: source, bytes: inputSize, sha256Before: shaBefore, sha256AfterCopy: shaAfterCopy, sha256After: end.sha256, bytesAfter: end.bytes,
        unchanged, atEnd: end.state, copiedAt, snapshot: !unchanged, encrypted: !!key,
      },
      // What the SDK read: a private copy of the input, deleted at the end of the run.
      converted: 'a private copy of the input',
      copy: { sha256: shaCopy, sha256AtEnd: shaEnd, unchanged: shaEnd === shaCopy },
      output: { path: final, bytes: fs.statSync(partial).size },
      schemaSource: schema ? 'file, plus backlinks from the app schema (--schema)' : 'file',
      classes: Object.keys(result.model.classes).length,
      embeddedClasses: Object.keys(result.model.embedded).length,
      verification: result.verification,
      warnings,
      timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])),
      peakRssMB: Math.round(peakRss / 1048576),
      platform: `${os.platform()} ${os.arch()}, node ${process.version}`,
    };
    report.ok = ok;

    // Order (README, Output files): every check; then, without --force, the
    // database takes its name first, with link(), which fails if anything is at
    // <out>: only the run that gets <out> goes on to the report, so a run that
    // fails here never touches it. Then the report files take their names (an
    // old report is moved aside, not deleted). With --force (or for <out>.failed)
    // the database rename comes last and is the commit. If anything fails, the
    // run deletes what it created (<out> too, when it created it) and moves the
    // old report back.
    const replace = !ok || !!opts.force;
    const exists = () => new Error(`output exists: ${final} (created during the conversion; use --force)`);
    const commitDb = () => {
      try {
        if (replace) keepNarrowerMode(partial, final);
        commitName(partial, final, { replace, exists });
      } catch (e) {
        if (e.code) e.message = `cannot ${replace ? 'replace' : 'create'} ${final}: ${e.message}`;
        throw e;
      }
      created.renamed(partial, final);
    };
    const reportFiles = rep === undefined ? [] : REPORT_FILES.map((f) => path.join(rep, f));
    let temps = [];
    if (rep !== undefined) {
      created.mkdir(rep);
      const contents = [JSON.stringify(report, null, 2), toMarkdown(report)];
      temps = REPORT_FILES.map((f, i) => createUnique(path.join(rep, '.' + f), '.tmp', created, { content: contents[i], mode }));
    }
    // All checks run here: after the new folder and files of the run exist (a
    // folder created under another case can be <out>), before any old file moves.
    const sources = sourceFiles(source, sdk);
    checkTarget(final, sources, reportFiles, { failed: !ok, force: replace });
    checkSqliteTarget(final, !ok);
    for (const target of reportFiles) checkTarget(target, sources, [out, out + '.failed', partial]);
    if (!replace) commitDb();
    // Two names that differ only in case (or are otherwise the same entry on
    // this disk) can only be seen once both exist: before and after the renames.
    const sameAsFinal = () => {
      for (const target of reportFiles) {
        if (sameFile(lstatOf(target), lstatOf(final))) throw new Error(`${final} is the same file as ${target} on this disk; choose another output name or report folder`);
      }
    };
    sameAsFinal();
    for (const [i, target] of reportFiles.entries()) {
      keepNarrowerMode(temps[i], target);
      created.moveAside(target, path.join(rep, '.' + REPORT_FILES[i]));
      fs.renameSync(temps[i], target);
      created.renamed(temps[i], target);
    }
    sameAsFinal();
    if (replace) commitDb();
    created.commit();
    return report;
  } catch (e) {
    created.removeAll();
    throw e;
  } finally {
    created.removeTrees(); // the copy of the input, in every case (already done by commit() or removeAll())
  }
}

/**
 * Re-run verification on an existing output file (model read from the meta
 * table). No app schema is needed: backlinks are computed from the forward
 * links. As in convert(), the SDK reads a private copy of the input, made in
 * the folder of the SQLite file and deleted at the end.
 */
export async function verifyFile(input, sqliteFile, opts = {}) {
  const key = typeof opts.key === 'string' ? parseKey(opts.key) : opts.key;
  const source = fs.realpathSync.native(input);
  const db = new Database(sqliteFile, { readonly: true, fileMustExist: true });
  const created = new Created();
  let realm;
  try {
    const copied = statOf(source);
    const shaBefore = await fileSha256(source);
    const copy = await privateCopy(source, path.dirname(fs.realpathSync.native(sqliteFile)), created);
    const shaCopy = await fileSha256(copy);
    if (shaCopy !== shaBefore || (await fileSha256(source)) !== shaBefore) throw new Error(`the file changed while it was copied: close the app, or pull a copy of the file first (${input})`);
    try {
      realm = await openRealm(copy, { key });
    } catch (e) {
      if (typeof e?.message === 'string') e.message = e.message.split(copy).join(source);
      throw e;
    }
    const model = JSON.parse(db.prepare(`SELECT "value" FROM ${q(META_TABLE)} WHERE "key" = 'model'`).pluck().get());
    const v = await verify(realm, db, model, { sample: opts.sample ?? 300, seed: opts.seed ?? 1 });
    realm.close();
    realm = null;
    // verification: the output against the copy; copyUnchanged: the bytes the
    // SDK read did not change; sourceUnchanged: the source at the end of the run
    // is still the file that was copied (sourceAtEnd: see sourceAtEnd()).
    const copyUnchanged = (await fileSha256(copy)) === shaBefore;
    const end = await sourceAtEnd(source, shaBefore, fs.statSync(copy).size, { copy, copied });
    return { verification: v, copyUnchanged, sourceUnchanged: end.state === 'unchanged', sourceAtEnd: end.state };
  } finally {
    db.close();
    realm?.close();
    created.removeAll();
  }
}
