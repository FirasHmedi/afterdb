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
import { relax } from './gc.mjs';
import { writeReport } from './report.mjs';

export const TOOL_VERSION = '0.1.0';

export async function fileSha256(file) {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
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

const AUX = ['.lock', '.note', '.management', '.fresh.lock', '.log', '.log_a', '.log_b'];

/**
 * Open the source read-only, without a schema: the SDK then exposes exactly the
 * classes and properties stored in the file. Files the SDK creates next to it
 * (.lock, .note, .management) are removed afterwards if they did not exist before.
 */
async function openSource(input, { key }) {
  const existing = new Set(AUX.filter((s) => fs.existsSync(input + s)));
  const config = { path: path.resolve(input), readOnly: true };
  if (key) config.encryptionKey = key;
  const realm = await Realm.open(config);
  const cleanup = () => {
    for (const s of AUX) {
      if (!existing.has(s) && fs.existsSync(input + s)) fs.rmSync(input + s, { recursive: true, force: true });
    }
  };
  return { realm, cleanup };
}

/** fs.Stats of a path (links followed), or null when nothing is there. */
function statOf(p) {
  try {
    return fs.statSync(p, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}
const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const rmQuiet = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } };

/**
 * The tool deletes an old <out>.partial, writes the new file there, then renames
 * it to <out> or <out>.failed. None of these may be the input: same path, the
 * same name in another case on a case-insensitive disk, or a link to it. None may
 * be a folder either. Checked before any work, with or without --force.
 */
function checkPaths(input, output, report) {
  const src = statOf(input);
  for (const p of [output, output + '.partial', output + '.failed']) {
    const s = statOf(p);
    if (sameFile(s, src)) throw new Error(`${p} is the input file; choose another output name`);
    if (s?.isDirectory()) throw new Error(`${p} is a folder; give a file name for the output`);
  }
  if (report) {
    const s = statOf(report);
    if (s && !s.isDirectory()) throw new Error(`--report must be a folder: ${report}`);
    if (s) {
      try { fs.accessSync(report, fs.constants.W_OK); } catch { throw new Error(`--report folder is not writable: ${report}`); }
    }
    for (const f of ['report.json', 'report.md']) {
      if (sameFile(statOf(path.join(report, f)), src)) throw new Error(`${path.join(report, f)} is the input file; choose another report folder`);
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

  if (!fs.existsSync(input)) throw new Error(`input not found: ${input}`);
  const src = checkPaths(input, output, opts.report);
  // With --force the old output stays in place until the new one is verified.
  if (fs.existsSync(output) && !opts.force) throw new Error(`output exists: ${output} (use --force)`);
  const shaBefore = await fileSha256(input);
  const inputSize = fs.statSync(input).size;
  timings.hashBeforeMs = performance.now() - t0;

  let t = performance.now();
  const { realm, cleanup } = await openSource(input, { key });
  timings.openMs = performance.now() - t;
  const partial = output + '.partial';
  let db;
  let result;
  try {
    fs.rmSync(partial, { force: true }); // left by an interrupted run; checked above: not the input
    db = new Database(partial);
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
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('foreign_keys = OFF');
    const { tables, after } = ddl(model);
    db.exec(tables.join('\n'));

    // Load, class by class, in batches.
    t = performance.now();
    const stats = { special: 0, unsafeInt: 0 };
    const loadCounts = {};
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
      const insertBatch = db.transaction((from, to) => {
        for (let i = from; i < to; i++) {
          const obj = results[i];
          ins.run(rowOf(model, tm, obj, stats));
          if (tm.lists.length === 0) continue;
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
        }
      });
      for (let i = 0; i < n; i += batchSize) {
        insertBatch(i, Math.min(n, i + batchSize));
        if ((i / batchSize) % 10 === 9) { sampleRss(); await relax(); }
      }
      loadCounts[tm.name] = n;
      await relax();
    }
    sampleRss();
    timings.loadMs = performance.now() - t;
    if (stats.special) warnings.push(`${stats.special} double/float value(s) are NaN, -0 or ±Infinity: kept via the "<column>__x" companion column (NaN, -0); Infinity is native REAL.`);
    if (stats.unsafeInt) warnings.push(`${stats.unsafeInt} int value(s) exceed 2^53: the JS SDK already reads them rounded; stored as read.`);

    t = performance.now();
    db.exec(after.join('\n'));
    const meta = db.prepare(`INSERT INTO ${q(META_TABLE)} VALUES (?, ?)`);
    meta.run('model', JSON.stringify(model));
    meta.run('renames', JSON.stringify(model.renames));
    meta.run('tool', `@keelstore/converter ${TOOL_VERSION}`);
    meta.run('source_sha256', shaBefore);
    timings.indexMs = performance.now() - t;

    if (opts._beforeVerify) opts._beforeVerify(db); // test hook
    t = performance.now();
    const verification = await verify(realm, db, model, { sample, seed: opts.seed ?? 1 });
    sampleRss();
    timings.verifyMs = performance.now() - t;
    result = { model, verification, loadCounts };
  } catch (e) {
    db?.close();
    rmQuiet(partial);
    throw e;
  } finally {
    if (db?.open) {
      db.pragma('journal_mode = DELETE');
      db.close();
    }
    realm.close();
    cleanup();
  }
  // Everything below happens before the rename: the report is written first, so
  // if anything fails (hash, report, rename) the run is an error, .partial and
  // the new report files are deleted, and any old <out> is left as it was.
  let reportFiles = [];
  try {
    t = performance.now();
    const shaAfter = await fileSha256(input);
    timings.hashAfterMs = performance.now() - t;
    // Only a verified file gets the final name (replacing any old one). A failed
    // one is kept as <out>.failed for inspection, so it cannot be shipped by mistake.
    const ok = shaBefore === shaAfter && result.verification.ok;
    const final = ok ? output : output + '.failed';
    if (!ok) warnings.push(`Verification failed: output kept as ${final}; ${output} was not written.`);
    timings.totalMs = performance.now() - t0;
    sampleRss();

    const report = {
      tool: `@keelstore/converter ${TOOL_VERSION}`,
      createdAt: new Date().toISOString(),
      input: { path: path.resolve(input), bytes: inputSize, sha256Before: shaBefore, sha256After: shaAfter, unchanged: shaBefore === shaAfter, encrypted: !!key },
      output: { path: path.resolve(final), bytes: fs.statSync(partial).size },
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
    if (opts.report) reportFiles = writeReport(opts.report, report);
    if (sameFile(statOf(final), src)) throw new Error(`${final} is the input file; choose another output name`);
    fs.renameSync(partial, final);
    return report;
  } catch (e) {
    rmQuiet(partial);
    for (const f of reportFiles) rmQuiet(f);
    throw e;
  }
}

/**
 * Re-run verification on an existing output file (model read from _keel_meta).
 * No app schema is needed: backlinks are read with linkingObjects().
 */
export async function verifyFile(input, sqliteFile, opts = {}) {
  const key = typeof opts.key === 'string' ? parseKey(opts.key) : opts.key;
  const shaBefore = await fileSha256(input);
  const { realm, cleanup } = await openSource(input, { key });
  const db = new Database(sqliteFile, { readonly: true });
  try {
    const model = JSON.parse(db.prepare('SELECT "value" FROM "_keel_meta" WHERE "key" = \'model\'').pluck().get());
    const v = await verify(realm, db, model, { sample: opts.sample ?? 300, seed: opts.seed ?? 1 });
    return { verification: v, sourceUnchanged: shaBefore === (await fileSha256(input)) };
  } finally {
    db.close();
    realm.close();
    cleanup();
  }
}
