// Regression tests for the adversarial review of the converter. Each test uses
// the same inputs as the review's reproduction script.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Realm from 'realm';
import Database from 'better-sqlite3';
import { convert, fileSha256 } from '../src/convert.mjs';
import { mergeAppSchema, normalizeAppSchema } from '../src/schema.mjs';
import { translate, RqlError, Unsupported } from '../src/rql.mjs';
import { backlinkIndex, keyR, cmpKey } from '../src/canon.mjs';
import { indexClasses } from '../src/sdk.mjs';
import { tmpPath, makeAllTypes, schema as allTypesSchema } from './fixtures.mjs';

after(() => Realm.shutdown());

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin/afterdb-convert.mjs');
const cli = (args, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, BIN, ...args], { encoding: 'utf8', timeout: 60_000 });

function tmpDir(name) {
  const d = tmpPath(name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
async function make(file, schema, fill) {
  const r = await Realm.open({ path: file, schema });
  if (fill) r.write(() => fill(r));
  r.close();
}
const SCHEMA = [{ name: 'A', primaryKey: 'id', properties: { id: 'int', s: 'string', d: 'double?' } }];
const fill = (n) => (r) => { for (let i = 0; i < n; i++) r.create('A', { id: i, s: 'v' + i, d: i / 3 }); };
const tamper = (db) => db.exec('DELETE FROM "A" WHERE "id" = 1');
// Files in a folder, without the ones the SDK keeps next to a realm it created.
const ls = (d) => fs.readdirSync(d).filter((f) => !/\.realm\.(lock|note|management)$/.test(f)).sort();
// Temporary files of a run (afterdb.<12 hex>.partial, the private copy afterdb.<12 hex>.copy/,
// .report.json.<12 hex>.tmp), anywhere under d.
const temps = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => /\.[0-9a-f]{12}\.(partial|tmp|copy)$/.test(f));
const meta = (file, key) => {
  const db = new Database(file, { readonly: true });
  try { return JSON.parse(db.prepare('SELECT "value" FROM "_afterdb_meta" WHERE "key" = ?').pluck().get(key)); } finally { db.close(); }
};
const sqlAll = (file, sql) => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};
async function realmCount(file, cls) {
  const r = await Realm.open({ path: file, readOnly: true });
  try { return r.objects(cls).length; } finally { r.close(); }
}

// ---------- output files ----------

test('output that is the input file is refused, with or without --force (same path, case variant, links)', async () => {
  const d = tmpDir('reg-same');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const sha = await fileSha256(inp);

  const r = cli([inp, inp, '--force']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is the input file/);
  await assert.rejects(convert(inp, inp, { force: true }), /is the input file/);
  await assert.rejects(convert(inp, inp), /is the input file/); // not "use --force"

  fs.symlinkSync(inp, path.join(d, 'soft.sqlite'));
  fs.linkSync(inp, path.join(d, 'hard.sqlite'));
  for (const out of ['soft.sqlite', 'hard.sqlite']) await assert.rejects(convert(inp, path.join(d, out), { force: true }), /is the input file/);
  assert.equal(await fileSha256(inp), sha);
  assert.equal(await realmCount(inp, 'A'), 50);
  assert.deepEqual(ls(d), ['app.realm', 'hard.sqlite', 'soft.sqlite']);

  // Case variant: App.realm -> app.realm, the same file on a case-insensitive disk.
  const d2 = tmpDir('reg-case');
  const upper = path.join(d2, 'App.realm');
  await make(upper, SCHEMA, fill(50));
  const lower = path.join(d2, 'app.realm');
  if (fs.existsSync(lower)) {
    const sha2 = await fileSha256(upper);
    const r2 = cli([upper, lower, '--force']);
    assert.equal(r2.status, 1, r2.stdout + r2.stderr);
    assert.match(r2.stderr, /is the input file/);
    assert.equal(await fileSha256(upper), sha2);
    assert.equal(await realmCount(upper, 'A'), 50);
  }
});

test('inputs named like the SQLite files of the output: the temporary name is unique, the others are refused', async () => {
  const d = tmpDir('reg-collide');
  const gen = path.join(d, 'gen', 'gen.realm');
  fs.mkdirSync(path.dirname(gen));
  await make(gen, SCHEMA, fill(50));
  const sha = await fileSha256(gen);
  const copy = (name) => { const f = path.join(d, name); fs.copyFileSync(gen, f); return f; };

  // The database is written to a new file with a unique name: an input named
  // <out>.partial (the old fixed name) or <out>.partial-journal / -wal (side
  // files SQLite deleted when it opened <out>.partial) is not touched.
  for (const name of ['export.partial', 'export.partial-journal', 'export.partial-wal', 'export.partial-shm']) {
    const inp = copy(name);
    const out = path.join(d, 'export');
    const r = cli([inp, out]);
    assert.equal(r.status, 0, name + ': ' + r.stdout + r.stderr);
    assert.equal(await fileSha256(inp), sha, name);
    assert.equal(await realmCount(inp, 'A'), 50, name);
    fs.rmSync(out);
    fs.rmSync(inp);
  }

  // <out>.failed may be replaced, and SQLite applies (then deletes) <db>-journal
  // or <db>-wal when it opens <db>: all refused before any work.
  for (const name of ['x.failed', 'x-journal', 'x-wal', 'x-shm', 'x.failed-journal', 'x.failed-wal']) {
    const inp = copy(name);
    const r = cli([inp, path.join(d, 'x')]);
    assert.equal(r.status, 1, name + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`${name.replace('.', '\\.')} is the input file`), name);
    assert.equal(await fileSha256(inp), sha, name);
    assert.deepEqual(ls(d), ['gen', name], name);
    fs.rmSync(inp);
  }
  const inB = copy('y.failed');
  await assert.rejects(convert(inB, path.join(d, 'y'), { _beforeVerify: tamper }), /y\.failed is the input file/);
  assert.equal(await fileSha256(inB), sha);
  fs.rmSync(inB);

  // A stale journal next to the output (not the input) would be applied to the
  // new file by the next program that opens it: refused, nothing deleted.
  const inp = copy('app.realm');
  const out = path.join(d, 'o.sqlite');
  fs.writeFileSync(out, 'OLD');
  for (const side of ['-journal', '-wal', '-shm']) {
    fs.writeFileSync(out + side, 'NOT MINE');
    const r = cli([inp, out, '--force']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`o\\.sqlite${side} exists: SQLite would apply it`));
    assert.equal(fs.readFileSync(out + side, 'utf8'), 'NOT MINE');
    assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
    fs.rmSync(out + side);
  }
  assert.deepEqual(ls(d), ['app.realm', 'gen', 'o.sqlite']);
  // The files the SDK keeps next to the input are never outputs either.
  for (const aux of ['.lock', '.note', '.management']) {
    const r = cli([inp, inp + aux, '--force']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /a file the SDK uses next to the input/);
  }
  assert.equal(await fileSha256(inp), sha);
});

test('--report errors leave the old output untouched and write nothing (exit 1)', async () => {
  const d = tmpDir('reg-report');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const out = path.join(d, 'out.sqlite');
  fs.writeFileSync(out, 'OLD');
  const repFile = path.join(d, 'rep');
  fs.writeFileSync(repFile, 'a file, not a folder');

  // A: --force, report path is a file.
  const a = cli([inp, out, '--force', '--report', repFile]);
  assert.equal(a.status, 1, a.stdout + a.stderr);
  assert.match(a.stderr, /--report must be a folder/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');

  // B: failed verification (preloaded hook) and a bad report path: exit 1, nothing on disk.
  const hook = path.join(d, 'tamper-hook.mjs');
  fs.writeFileSync(hook, `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('better-sqlite3');
const orig = Database.prototype.prepare;
let done = false;
Database.prototype.prepare = function (sql) {
  if (!done && sql.startsWith('INSERT INTO "_afterdb_meta"')) { done = true; this.exec('DELETE FROM "A" WHERE id = 1'); }
  return orig.call(this, sql);
};
`);
  const out2 = path.join(d, 'out2.sqlite');
  const b = cli([inp, out2, '--report', repFile], ['--import', pathToFileURL(hook).href]);
  assert.equal(b.status, 1, b.stdout + b.stderr);
  assert.deepEqual(ls(d).filter((f) => f.startsWith('out2')), []);
  const b2 = cli([inp, out2, '--report', path.join(d, 'rep-ok')], ['--import', pathToFileURL(hook).href]);
  assert.equal(b2.status, 2, b2.stdout + b2.stderr); // control: a good report path keeps exit 2
  assert.deepEqual(ls(d).filter((f) => f.startsWith('out2')), ['out2.sqlite.failed']);

  // report.json is a folder: refused before the conversion, nothing written.
  const rep2 = path.join(d, 'rep2');
  fs.mkdirSync(path.join(rep2, 'report.json'), { recursive: true });
  await assert.rejects(convert(inp, out, { force: true, report: rep2 }), /report\.json is a folder/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
  assert.deepEqual(ls(rep2), ['report.json']);

  // Read-only report folder: refused before the conversion.
  if (process.getuid?.() !== 0) {
    const ro = path.join(d, 'ro');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o555);
    try {
      await assert.rejects(convert(inp, out, { force: true, report: ro }), /not writable/);
    } finally {
      fs.chmodSync(ro, 0o755);
    }
    assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
  }
  assert.deepEqual(temps(d), []);
});

test('--batch and --sample must be whole numbers in range (exit 1, nothing left behind)', async () => {
  const d = tmpDir('reg-batch');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  for (const [opt, v] of [['--batch', '0'], ['--batch', '-1'], ['--batch', '0.5'], ['--batch', 'abc'], ['--sample', 'abc'], ['--sample', '-5'], ['--sample', '']]) {
    const r = cli([inp, path.join(d, 'b.sqlite'), opt, v]);
    assert.equal(r.status, 1, `${opt} ${v}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${opt} needs a whole number`));
  }
  assert.deepEqual(ls(d), ['app.realm']);
  await assert.rejects(convert(inp, path.join(d, 'c.sqlite'), { batchSize: 0 }), /batch size/);
  await assert.rejects(convert(inp, path.join(d, 'c.sqlite'), { sample: NaN }), /sample size/);
  assert.deepEqual(ls(d), ['app.realm']);
  const zero = cli([inp, path.join(d, 's.sqlite'), '--sample', '0']);
  assert.equal(zero.status, 0, zero.stdout + zero.stderr);
  assert.match(zero.stdout, /0\/0 sample field mismatches/);
});

test('an output path that is a folder is refused before the conversion; a failed rename deletes the temporary file', async () => {
  const d = tmpDir('reg-folder');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const exp = path.join(d, 'exports');
  fs.mkdirSync(exp);
  fs.writeFileSync(path.join(exp, 'keep.txt'), 'keep');
  for (const args of [[inp, exp], [inp, exp, '--force'], [inp, exp + '/', '--force']]) {
    const r = cli(args);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /is a folder/);
  }
  assert.deepEqual(ls(exp), ['keep.txt']);
  assert.deepEqual(ls(d), ['app.realm', 'exports']);

  // A folder that appears at <out> during the run: the rename fails, the temporary file is deleted.
  const out = path.join(d, 'late.sqlite');
  await assert.rejects(convert(inp, out, { _beforeVerify: () => fs.mkdirSync(out) }), /late\.sqlite is a folder/);
  assert.deepEqual(ls(d), ['app.realm', 'exports', 'late.sqlite']);
});

// ---------- names ----------

test('--schema does not rename stored list tables: backlink views are named last', async () => {
  const d = tmpDir('reg-stable');
  const cases = [
    // A, A_ with list x: A[]; the app adds backlink A._x.
    {
      file: [{ name: 'A', properties: { v: 'int' } }, { name: 'A_', properties: { x: 'A[]' } }],
      fill: (r) => { const a = r.create('A', { v: 1 }); r.create('A_', { x: [a, a] }); },
      app: (file) => [{ name: 'A', properties: { v: 'int', _x: { type: 'linkingObjects', objectType: 'A_', property: 'x' } } }, file[1]],
      list: ['A_', 'A___x'], view: ['A', '_x', 'A___x_2'],
    },
    // A, A__b with list c: A[]; the app adds backlink A.b__c.
    {
      file: [{ name: 'A', primaryKey: 'id', properties: { id: 'int' } }, { name: 'A__b', primaryKey: 'id', properties: { id: 'int', c: 'A[]' } }],
      fill: (r) => { const a = r.create('A', { id: 1 }); r.create('A__b', { id: 1, c: [a, a] }); },
      app: (file) => [{ name: 'A', primaryKey: 'id', properties: { id: 'int', b__c: { type: 'linkingObjects', objectType: 'A__b', property: 'c' } } }, file[1]],
      list: ['A__b', 'A__b__c'], view: ['A', 'b__c', 'A__b__c_2'],
    },
  ];
  for (const [i, c] of cases.entries()) {
    const src = path.join(d, `ns${i}.realm`);
    await make(src, c.file, c.fill);
    const plain = await convert(src, path.join(d, `ns${i}-file.sqlite`));
    const withApp = await convert(src, path.join(d, `ns${i}-app.sqlite`), { schema: c.app(c.file) });
    assert.equal(plain.ok, true);
    assert.equal(withApp.ok, true, JSON.stringify(withApp.verification));
    const [lc, lt] = c.list;
    for (const f of [`ns${i}-file.sqlite`, `ns${i}-app.sqlite`]) {
      assert.deepEqual(meta(path.join(d, f), 'model').classes[lc].lists.map((l) => l.table), [lt], f);
      assert.deepEqual(sqlAll(path.join(d, f), `SELECT type, (SELECT count(*) FROM "${lt}") AS n FROM sqlite_master WHERE name = '${lt}'`), [{ type: 'table', n: 2 }]);
    }
    const [vc, vp, vt] = c.view;
    assert.deepEqual(meta(path.join(d, `ns${i}-app.sqlite`), 'renames'), [{ kind: 'backlink view', class: vc, prop: vp, from: lt, to: vt }]);
    assert.deepEqual(withApp.verification.views.map((v) => [v.view, v.rows, v.ok]), [[vt, 2, true]]);
    assert.deepEqual(meta(path.join(d, `ns${i}-file.sqlite`), 'renames'), []);
  }
});

test('index renames are recorded in _afterdb_meta, the model and the warnings', async () => {
  const d = tmpDir('reg-idx');
  const schema = [
    { name: 'A', primaryKey: 'id', properties: { id: 'int', link: 'A?', code: { type: 'string', indexed: true } } },
    { name: 'A__link', properties: { z: 'int' } },
    { name: 'A__code', properties: { z: 'int' } },
    { name: 'B', primaryKey: 'id', properties: { id: 'int', items: 'B[]' } },
    { name: 'B__items__target', properties: { z: 'int' } },
  ];
  const src = path.join(d, 'idx.realm');
  await make(src, schema, (r) => {
    const a = r.create('A', { id: 1, code: 'x' });
    a.link = a;
    r.create('A__link', { z: 1 });
    r.create('A__code', { z: 2 });
    const b = r.create('B', { id: 1 });
    b.items = [b];
    r.create('B__items__target', { z: 3 });
  });
  const out = path.join(d, 'idx.sqlite');
  const r = await convert(src, out);
  assert.equal(r.ok, true);
  const expected = [
    { kind: 'index', class: 'A', prop: 'link', from: 'A__link', to: 'A__link_2' },
    { kind: 'index', class: 'A', prop: 'code', from: 'A__code', to: 'A__code_2' },
    { kind: 'index', class: 'B', prop: 'items', from: 'B__items__target', to: 'B__items__target_2' },
  ];
  assert.deepEqual(meta(out, 'renames'), expected);
  assert.deepEqual(meta(out, 'model').renames, expected);
  assert.deepEqual(sqlAll(out, `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((x) => x.name),
    ['A__code_2', 'A__link_2', 'B__items__target_2']);
  for (const x of expected) assert.ok(r.warnings.some((w) => w.startsWith(`${x.class}.${x.prop}: index stored as "${x.to}"`)), r.warnings.join('\n'));
});

test('backlinks named like Object.prototype members (toString, valueOf...) are converted', async () => {
  const d = tmpDir('reg-proto');
  for (const bl of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const app = [
      { name: 'O', properties: { t: 'T?' } },
      { name: 'T', properties: { x: 'int', [bl]: { type: 'linkingObjects', objectType: 'O', property: 't' } } },
    ];
    const f = path.join(d, `n-${bl}.realm`);
    await make(f, app, (r) => { const t = r.create('T', { x: 1 }); r.create('O', { t }); r.create('O', { t }); });
    const res = await convert(f, path.join(d, `n-${bl}.sqlite`), { schema: app });
    assert.equal(res.ok, true, bl);
    assert.deepEqual(res.verification.views, [{ view: `T__${bl}`, expected: 2, rows: 2, ok: true }], bl);
    assert.deepEqual(res.warnings.filter((w) => w.includes('backlink')), [], bl);
  }

  const file = [
    { name: 'Author', primaryKey: 'id', properties: { id: 'int' } },
    { name: 'Book', primaryKey: 'id', properties: { id: 'int', author: 'Author?' } },
  ];
  const app = [
    { name: 'Author', primaryKey: 'id', properties: { id: 'int', books: { type: 'linkingObjects', objectType: 'Book', property: 'author' }, valueOf: { type: 'linkingObjects', objectType: 'Book', property: 'author' } } },
    file[1],
  ];
  const src = path.join(d, 'blproto.realm');
  await make(src, file, (r) => { const a = r.create('Author', { id: 1 }); r.create('Book', { id: 1, author: a }); r.create('Book', { id: 2, author: a }); });
  const out = path.join(d, 'blproto.sqlite');
  const rep = await convert(src, out, { schema: app });
  assert.equal(rep.ok, true);
  assert.deepEqual(sqlAll(out, `SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`).map((x) => x.name), ['Author__books', 'Author__valueOf']);
  assert.deepEqual(sqlAll(out, 'SELECT owner, source FROM "Author__valueOf" ORDER BY source'), [{ owner: 1, source: 1 }, { owner: 1, source: 2 }]);
  assert.deepEqual(rep.warnings.filter((w) => w.includes('stored property')), []);

  // An app-only stored property named toString is reported as drift.
  const m = mergeAppSchema(normalizeAppSchema([{ name: 'T', properties: { x: 'int' } }]), [{ name: 'T', properties: { x: 'int', toString: 'int' } }]);
  assert.deepEqual(m.warnings, ['Schema drift: property T.toString is in the app schema but not in the file; no column.']);
});

// ---------- schema drift ----------

test('drift warnings cover optionality, embedded/top-level and indexes, without false positives', async () => {
  const d = tmpDir('reg-drift');
  const file = [
    { name: 'E', embedded: true, properties: { s: 'string' } },
    { name: 'P', primaryKey: '_id', properties: { _id: 'int', req: 'int', opt: 'int?', reqL: 'int[]', optL: 'int?[]', e: 'E?', d: 'double', idx: { type: 'string', indexed: true } } },
    { name: 'Top', properties: { v: 'int' } },
  ];
  const src = path.join(d, 'drift.realm');
  await make(src, file, (r) => { r.create('P', { _id: 1, req: 1, opt: null, reqL: [1], optL: [null], e: { s: 'x' }, d: 1.5, idx: 'a' }); r.create('Top', { v: 1 }); });
  const app = [
    { name: 'E', properties: { s: 'string' } },
    { name: 'P', primaryKey: '_id', properties: { _id: 'int', req: 'int?', opt: 'int', reqL: 'int?[]', optL: 'int[]', e: 'E?', d: 'float', idx: 'string' } },
    { name: 'Top', embedded: true, properties: { v: 'int' } },
  ];
  const res = await convert(src, path.join(d, 'drift.sqlite'), { schema: app });
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings.filter((w) => w.startsWith('Schema drift')).sort(), [
    'Schema drift: P.d is double in the file, float in the app schema; the file is used.',
    'Schema drift: P.idx is indexed in the file, not indexed in the app schema; the file is used.',
    'Schema drift: P.opt is int? in the file, int in the app schema; the file is used.',
    'Schema drift: P.optL is list<int?> in the file, list<int> in the app schema; the file is used.',
    'Schema drift: P.req is int in the file, int? in the app schema; the file is used.',
    'Schema drift: P.reqL is list<int> in the file, list<int?> in the app schema; the file is used.',
    'Schema drift: class E is embedded in the file, top-level in the app schema; the file is used.',
    'Schema drift: class Top is top-level in the file, embedded in the app schema; the file is used.',
  ]);

  // The same schema on both sides (every type, links, embedded, collections, backlinks): no drift.
  const all = path.join(d, 'all.realm');
  await makeAllTypes(all, { n: 20 });
  const ok = await convert(all, path.join(d, 'all.sqlite'), { schema: allTypesSchema });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings.filter((w) => w.startsWith('Schema drift')), []);
});

// ---------- identifiers and SDK method names ----------

test('a double quote in a class or property name with a list or a backlink converts and verifies', async () => {
  const d = tmpDir('reg-quote');
  const cases = [
    [[{ name: 'Say"Hi', properties: { v: 'int', tags: 'string[]' } }], (r) => r.create('Say"Hi', { v: 1, tags: ['a', 'b'] }), null],
    [[{ name: 'Q', properties: { 'l"x': 'int[]' } }], (r) => r.create('Q', { 'l"x': [5] }), null],
    [
      [{ name: 'T"x', primaryKey: 'id', properties: { id: 'int' } }, { name: 'S', primaryKey: 'id', properties: { id: 'int', t: 'T"x?' } }],
      (r) => { const t = r.create('T"x', { id: 1 }); r.create('S', { id: 1, t }); },
      [{ name: 'T"x', primaryKey: 'id', properties: { id: 'int', srcs: { type: 'linkingObjects', objectType: 'S', property: 't' } } }, { name: 'S', primaryKey: 'id', properties: { id: 'int', t: 'T"x?' } }],
    ],
  ];
  for (const [i, [schema, fillFn, app]] of cases.entries()) {
    const src = path.join(d, `quote${i}.realm`);
    await make(src, schema, fillFn);
    const r = await convert(src, path.join(d, `quote${i}.sqlite`), app ? { schema: app } : {});
    assert.equal(r.ok, true, `case ${i}`);
  }
  const c = cli([path.join(d, 'quote0.realm'), path.join(d, 'quote0-cli.sqlite')]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^OK: 1 tables, 1 rows, 0 hash mismatches, 0\/2 sample field mismatches/);
});

test('stored properties named _objectKey, linkingObjects or objectSchema do not hide the SDK methods', async () => {
  const d = tmpDir('reg-meth');
  // _objectKey on a class without primary key.
  const k = path.join(d, 'meth0.realm');
  await make(k, [{ name: 'K', properties: { _objectKey: 'int', v: 'int' } }], (r) => r.create('K', { _objectKey: 7, v: 1 }));
  const r0 = await convert(k, path.join(d, 'meth0.sqlite'));
  assert.equal(r0.ok, true);
  assert.deepEqual(sqlAll(path.join(d, 'meth0.sqlite'), 'SELECT "_objectKey", "v" FROM "K"'), [{ _objectKey: 7, v: 1 }]);
  const c = cli([k, path.join(d, 'meth0-cli.sqlite')]);
  assert.equal(c.status, 0, c.stdout + c.stderr);

  // linkingObjects on a backlink target (--schema).
  const t = path.join(d, 'meth1.realm');
  await make(t, [{ name: 'Tgt', primaryKey: 'id', properties: { id: 'int', linkingObjects: 'string?' } }, { name: 'Src', primaryKey: 'id', properties: { id: 'int', t: 'Tgt?' } }],
    (r) => { const x = r.create('Tgt', { id: 1, linkingObjects: 'hello' }); r.create('Src', { id: 1, t: x }); });
  const app = [{ name: 'Tgt', primaryKey: 'id', properties: { id: 'int', linkingObjects: 'string?', srcs: { type: 'linkingObjects', objectType: 'Src', property: 't' } } }, { name: 'Src', primaryKey: 'id', properties: { id: 'int', t: 'Tgt?' } }];
  const r1 = await convert(t, path.join(d, 'meth1.sqlite'), { schema: app });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.verification.views, [{ view: 'Tgt__srcs', expected: 1, rows: 1, ok: true }]);

  // Query argument: an SDK object whose class has a property _objectKey.
  const schema = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', _objectKey: 'int' } }, { name: 'R', primaryKey: 'id', properties: { id: 'int', k: 'K?' } }];
  const okarg = path.join(d, 'okarg.realm');
  await make(okarg, schema, (r) => { for (let i = 0; i < 3; i++) { const x = r.create('K', { id: i, _objectKey: 10 + i }); r.create('R', { id: i, k: x }); } });
  const out = path.join(d, 'okarg.sqlite');
  assert.equal((await convert(okarg, out)).ok, true);
  const model = meta(out, 'model');
  const realm = await Realm.open({ path: okarg, readOnly: true });
  const db = new Database(out, { readonly: true });
  try {
    const k1 = realm.objectForPrimaryKey('K', 1);
    const sdk = [...realm.objects('R').filtered('k == $0', k1)].map((o) => o.id);
    const q = translate('k == $0', { model, className: 'R', args: [k1] });
    assert.deepEqual(db.prepare(q.sql).pluck().all(...q.params), sdk);
    assert.deepEqual(sdk, [1]);
  } finally {
    db.close();
    realm.close();
  }

  // objectSchema and _objectKey on a class without primary key, used as a query argument.
  const os = path.join(d, 'os.realm');
  await make(os, [{ name: 'K', properties: { objectSchema: 'string', _objectKey: 'int' } }, { name: 'H', primaryKey: 'id', properties: { id: 'int', k: 'K?' } }],
    (r) => { const a = r.create('K', { objectSchema: 'x', _objectKey: 9 }); r.create('K', { objectSchema: 'y', _objectKey: 8 }); r.create('H', { id: 1, k: a }); r.create('H', { id: 2, k: null }); });
  const osOut = path.join(d, 'os.sqlite');
  assert.equal((await convert(os, osOut)).ok, true);
  const realm2 = await Realm.open({ path: os, readOnly: true });
  try {
    const q = translate('k == $0', { model: meta(osOut, 'model'), className: 'H', args: [realm2.objects('K')[0]] });
    const db2 = new Database(osOut, { readonly: true });
    assert.deepEqual(db2.prepare(q.sql).pluck().all(...q.params), [1]);
    db2.close();
  } finally {
    realm2.close();
  }
});

// ---------- query translation ----------

test('True, False, tRUE are property names, not boolean literals (as in the SDK)', async () => {
  const d = tmpDir('reg-tf');
  const schema = [{ name: 'T', primaryKey: 'id', properties: { id: 'int', flag: 'bool', n: 'int', True: 'bool', False: 'bool', tRUE: 'int' } }];
  const src = path.join(d, 'tf.realm');
  await make(src, schema, (r) => {
    for (let i = 0; i < 6; i++) r.create('T', { id: i, flag: i % 2 === 0, n: i % 3, True: i < 3, False: i >= 3, tRUE: 1 - (i % 2) });
  });
  const out = path.join(d, 'tf.sqlite');
  assert.equal((await convert(src, out)).ok, true);
  const model = meta(out, 'model');
  const realm = await Realm.open({ path: src, readOnly: true });
  const db = new Database(out, { readonly: true });
  try {
    const expected = { 'flag == True': [0, 2, 3, 5], 'flag == False': [1, 4], 'flag != True': [1, 4], 'n == tRUE': [3, 4], 'flag == true': [0, 2, 4], 'flag == FALSE': [1, 3, 5] };
    for (const [query, want] of Object.entries(expected)) {
      const sdk = [...realm.objects('T').filtered(query)].map((o) => o.id).sort((a, b) => a - b);
      const t = translate(query, { model, className: 'T' });
      const sql = db.prepare(t.sql).pluck().all(...t.params).sort((a, b) => a - b);
      assert.deepEqual(sdk, want, `SDK ${query}`);
      assert.deepEqual(sql, sdk, query);
    }
  } finally {
    db.close();
    realm.close();
  }
  // A class without a property named True: the SDK refuses the query, so does the translator.
  const m2 = { version: 1, embedded: {}, renames: [], classes: { U: { ...model.classes.T, name: 'U', props: { id: model.classes.T.props.id, flag: model.classes.T.props.flag } } } };
  assert.throws(() => translate('flag == True', { model: m2, className: 'U' }), /unknown property U\.True/);
  assert.doesNotThrow(() => translate('flag == true', { model: m2, className: 'U' }));
});

// ---------- second adversarial pass ----------

// Runs `query` on the SDK and through the translator; returns [sdk, sql], each
// sorted ids or an error marker ('error' for the SDK, the error class for SQL).
function both(realm, db, model, cls, query, args = []) {
  let sdk;
  let sql;
  try { sdk = [...realm.objects(cls).filtered(query, ...args)].map((o) => o.id).sort((a, b) => a - b); } catch { sdk = 'error'; }
  try {
    const t = translate(query, { model, className: cls, args });
    sql = db.prepare(t.sql).pluck().all(...t.params).sort((a, b) => a - b);
  } catch (e) {
    sql = e.constructor.name;
  }
  return [sdk, sql];
}

test('report folder and report files may not overlap the output files; old reports are never deleted', async () => {
  const d = tmpDir('reg-repover');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const hook = path.join(d, 'tamper-hook.mjs');
  fs.writeFileSync(hook, `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('better-sqlite3');
const orig = Database.prototype.prepare;
let done = false;
Database.prototype.prepare = function (sql) {
  if (!done && sql.startsWith('INSERT INTO "_afterdb_meta"')) { done = true; this.exec('DELETE FROM "A" WHERE id = 1'); }
  return orig.call(this, sql);
};
`);
  const tampered = ['--import', pathToFileURL(hook).href];
  const sub = (n) => { const x = path.join(d, n); fs.mkdirSync(x, { recursive: true }); return x; };

  // R4: <out> is <rep>/report.json, old output there, verification fails.
  let x = sub('r4');
  fs.mkdirSync(path.join(x, 'rep'));
  let out = path.join(x, 'rep', 'report.json');
  fs.writeFileSync(out, 'OLD');
  let r = cli([inp, out, '--force', '--report', path.join(x, 'rep')], tampered);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /report\.json is .*report\.json, which the conversion writes/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
  assert.deepEqual(ls(x), ['rep']);
  assert.deepEqual(ls(path.join(x, 'rep')), ['report.json']);
  // R4b: the same without an old output, verification passes.
  x = sub('r4b');
  out = path.join(x, 'rep', 'report.json');
  r = cli([inp, out, '--report', path.join(x, 'rep')]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(ls(x), []);
  // R7: rep/report.json is a link to the old output, verification fails.
  x = sub('r7');
  out = path.join(x, 'out.sqlite');
  fs.writeFileSync(out, 'OLD');
  fs.mkdirSync(path.join(x, 'rep'));
  fs.symlinkSync(out, path.join(x, 'rep', 'report.json'));
  r = cli([inp, out, '--force', '--report', path.join(x, 'rep')], tampered);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /report\.json is .*out\.sqlite, which the conversion writes/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
  assert.ok(fs.lstatSync(path.join(x, 'rep', 'report.json')).isSymbolicLink());
  // R5: --report is <out>, <out>.failed or a folder inside <out> (none exists yet): refused, nothing created.
  x = sub('r5');
  out = path.join(x, 'out.sqlite');
  for (const rep of [out, out + '.failed', path.join(out, 'sub'), out + '-journal']) {
    r = cli([inp, out, '--report', rep]);
    assert.equal(r.status, 1, rep + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /--report .* (is|is inside) .*, which the conversion writes/);
    assert.deepEqual(ls(x), [], rep);
  }
  r = cli([inp, out, '--report', path.join(x, 'good')]);
  assert.equal(r.status, 0, r.stdout + r.stderr); // nothing blocks the rerun
  assert.deepEqual(ls(x), ['good', 'out.sqlite']);

  // R6: an old read-only report.json is refused (not deleted); R6b: report.md is a
  // folder, the old report.json is kept.
  if (process.getuid?.() !== 0) {
    x = sub('r6');
    out = path.join(x, 'out.sqlite');
    fs.writeFileSync(out, 'OLD');
    fs.mkdirSync(path.join(x, 'rep'));
    const rj = path.join(x, 'rep', 'report.json');
    fs.writeFileSync(rj, 'USER REPORT');
    fs.chmodSync(rj, 0o444);
    r = cli([inp, out, '--force', '--report', path.join(x, 'rep')]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /report\.json is read-only/);
    assert.equal(fs.readFileSync(rj, 'utf8'), 'USER REPORT');
    assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
  }
  x = sub('r6b');
  fs.mkdirSync(path.join(x, 'rep', 'report.md'), { recursive: true });
  fs.writeFileSync(path.join(x, 'rep', 'report.json'), 'USER REPORT');
  r = cli([inp, path.join(x, 'out.sqlite'), '--report', path.join(x, 'rep')]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(x, 'rep', 'report.json'), 'utf8'), 'USER REPORT');
  assert.deepEqual(ls(x), ['rep']);

  // An old report is replaced by the new one only when the run succeeds.
  x = sub('replace');
  fs.mkdirSync(path.join(x, 'rep'));
  fs.writeFileSync(path.join(x, 'rep', 'report.json'), 'OLD REPORT');
  fs.writeFileSync(path.join(x, 'rep', 'keep.txt'), 'keep');
  await assert.rejects(convert(inp, path.join(x, 'late.sqlite'), { report: path.join(x, 'rep'), _beforeVerify: () => fs.mkdirSync(path.join(x, 'late.sqlite')) }), /is a folder/);
  assert.equal(fs.readFileSync(path.join(x, 'rep', 'report.json'), 'utf8'), 'OLD REPORT');
  assert.deepEqual(ls(path.join(x, 'rep')), ['keep.txt', 'report.json']);
  // A report folder the run created is removed again on an error, an existing one is kept.
  await assert.rejects(convert(inp, path.join(x, 'late2.sqlite'), { report: path.join(x, 'new', 'deep'), _beforeVerify: () => fs.mkdirSync(path.join(x, 'late2.sqlite')) }), /is a folder/);
  assert.deepEqual(ls(x), ['late.sqlite', 'late2.sqlite', 'rep']);
  const ok = await convert(inp, path.join(x, 'ok.sqlite'), { report: path.join(x, 'rep') });
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x, 'rep', 'report.json'), 'utf8')).ok, true);
  assert.deepEqual(ls(path.join(x, 'rep')), ['keep.txt', 'report.json', 'report.md']);
  assert.deepEqual(temps(d), []);

  // Two names that differ only in case on a case-insensitive disk (not seen
  // before the run): caught before the rename, nothing left.
  x = sub('case');
  out = path.join(x, 'o.sqlite');
  fs.writeFileSync(path.join(x, 'probe'), '');
  if (fs.existsSync(path.join(x, 'PROBE'))) {
    await assert.rejects(convert(inp, out, { report: path.join(x, 'O.SQLITE') }), /is a folder/);
    assert.deepEqual(ls(x), ['probe']);
  }
});

test('empty output path, trailing slash, missing folder and dangling link are refused before any work', async () => {
  const d = tmpDir('reg-outpath');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const cwd = path.join(d, 'cwd');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, '.partial'), 'USER FILE');
  fs.writeFileSync(path.join(cwd, '.failed'), 'USER FILE');
  let r = spawnSync(process.execPath, [BIN, inp, ''], { encoding: 'utf8', cwd });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /output path required/);
  assert.deepEqual(ls(cwd), ['.failed', '.partial']);
  assert.equal(fs.readFileSync(path.join(cwd, '.partial'), 'utf8'), 'USER FILE');
  await assert.rejects(convert(inp, ''), /output path required/);

  r = cli([inp, path.join(d, 'new') + '/']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is a folder name; give a file name/);
  r = cli([inp, path.join(d, 'nowhere', 'o.sqlite')]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /output folder not found/);
  r = cli([inp, path.join(d, 'o.sqlite'), '--report', '']);
  assert.equal(r.status, 1, r.stdout + r.stderr);

  // A dangling link at <out> is an existing output: refused without --force, replaced with it.
  const ln = path.join(d, 'link.sqlite');
  fs.symlinkSync(path.join(d, 'target.sqlite'), ln);
  r = cli([inp, ln]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /output exists/);
  assert.ok(fs.lstatSync(ln).isSymbolicLink());
  r = cli([inp, ln, '--force']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.lstatSync(ln).isFile());
  assert.equal(fs.existsSync(path.join(d, 'target.sqlite')), false);
  assert.deepEqual(ls(d), ['app.realm', 'cwd', 'link.sqlite']);
});

test('<out>.failed is only checked when it is needed', async () => {
  const d = tmpDir('reg-failed');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const out = path.join(d, 'o.sqlite');
  fs.mkdirSync(out + '.failed');
  fs.writeFileSync(path.join(out + '.failed', 'keep.txt'), 'keep');
  const ok = await convert(inp, out);
  assert.equal(ok.ok, true);
  fs.rmSync(out);
  await assert.rejects(convert(inp, out, { _beforeVerify: tamper }), /verification failed, and .*o\.sqlite\.failed is a folder/);
  assert.deepEqual(ls(d), ['app.realm', 'o.sqlite.failed']);
  assert.deepEqual(ls(out + '.failed'), ['keep.txt']);
  fs.rmSync(out + '.failed', { recursive: true });
  // A stale journal next to <out>.failed would be applied to the failed file.
  fs.writeFileSync(out + '.failed-journal', 'NOT MINE');
  assert.equal((await convert(inp, out)).ok, true);
  fs.rmSync(out);
  await assert.rejects(convert(inp, out, { _beforeVerify: tamper }), /o\.sqlite\.failed-journal exists/);
  assert.equal(fs.readFileSync(out + '.failed-journal', 'utf8'), 'NOT MINE');
  assert.deepEqual(ls(d), ['app.realm', 'o.sqlite.failed-journal']);
});

test('an interrupted run (SIGINT) deletes its temporary file and report files, the old output stays', async () => {
  const d = tmpDir('reg-sigint');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const out = path.join(d, 'o.sqlite');
  fs.writeFileSync(out, 'OLD');
  const hook = path.join(d, 'sigint-hook.mjs');
  fs.writeFileSync(hook, `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('better-sqlite3');
const orig = Database.prototype.prepare;
let done = false;
Database.prototype.prepare = function (sql) {
  if (!done && sql.startsWith('INSERT INTO "_afterdb_meta"')) { done = true; process.kill(process.pid, 'SIGINT'); }
  return orig.call(this, sql);
};
`);
  const r = cli([inp, out, '--force', '--report', path.join(d, 'rep')], ['--import', pathToFileURL(hook).href]);
  // The process ends by SIGINT itself (the shell shows 130), so a calling script stops too.
  assert.equal(r.signal, 'SIGINT', `status ${r.status}: ${r.stdout}${r.stderr}`);
  assert.equal(r.status, null);
  assert.match(r.stderr, /interrupted \(SIGINT\)/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
  assert.deepEqual(ls(d), ['app.realm', 'o.sqlite', 'sigint-hook.mjs']);
});

test('stored properties named objectSchema or constructor on link and backlink targets, dictionary keys named like methods', async () => {
  const d = tmpDir('reg-shadow');
  for (const prop of ['objectSchema', 'constructor', 'linkingObjects', '_objectKey', 'keys', 'entries']) {
    const ptype = prop === 'constructor' ? 'string?' : 'int?';
    const T0 = { name: 'T', primaryKey: 'id', properties: { id: 'int' } };
    const T1 = { name: 'T', primaryKey: 'id', properties: { id: 'int', [prop]: ptype } };
    const S = { name: 'S', primaryKey: 'id', properties: { id: 'int', t: 'T?', ts: 'T[]', td: 'T{}', tset: 'T<>', m: 'mixed', ml: 'mixed[]', md: 'mixed{}' } };
    const f = path.join(d, prop + '.realm');
    // The SDK cannot create an object of a class with a stored "constructor":
    // links first, the property added afterwards (schema version 1).
    await make(f, [T0, S], (r) => {
      const t = [0, 1].map((i) => r.create('T', { id: i }));
      r.create('S', { id: 0, t: t[1], ts: [t[0], t[1], t[1]], td: { a: t[0], b: t[1] }, tset: [t[1]], m: t[1], ml: [t[0], [t[1]]], md: { a: t[1] } });
    });
    const r1 = await Realm.open({ path: f, schema: [T1, S], schemaVersion: 1 });
    r1.write(() => r1.objects('T').forEach((o, i) => { o[prop] = prop === 'constructor' ? 'c' + i : 10 + i; }));
    r1.close();
    const bl = (p) => ({ type: 'linkingObjects', objectType: 'S', property: p });
    const app = [{ ...T1, properties: { ...T1.properties, srcs: bl('t'), inLists: bl('ts'), inDicts: bl('td'), inSets: bl('tset') } }, S];
    const plain = await convert(f, path.join(d, prop + '.sqlite'));
    assert.equal(plain.ok, true, prop);
    const res = await convert(f, path.join(d, prop + '-s.sqlite'), { schema: app });
    assert.equal(res.ok, true, prop + ' ' + JSON.stringify(res.verification.mismatches));
    assert.deepEqual(res.verification.views.map((v) => [v.view, v.rows, v.ok]), [['T__srcs', 1, true], ['T__inLists', 3, true], ['T__inDicts', 2, true], ['T__inSets', 1, true]], prop);
    assert.deepEqual(sqlAll(path.join(d, prop + '-s.sqlite'), 'SELECT m, ml FROM "S"'), [{ m: '{"t":"link","c":"T","v":1}', ml: '[{"t":"link","c":"T","v":0},{"t":"list","v":[{"t":"link","c":"T","v":1}]}]' }], prop);
    assert.deepEqual(sqlAll(path.join(d, prop + '-s.sqlite'), `SELECT "${prop}" AS v FROM "T" ORDER BY id`).map((x) => x.v), prop === 'constructor' ? ['c0', 'c1'] : [10, 11], prop);
    if (prop === 'constructor') {
      // As a query argument: the SDK fails on it too, the translator says why.
      const realm = await Realm.open({ path: f, readOnly: true });
      try {
        const model = meta(path.join(d, prop + '.sqlite'), 'model');
        assert.throws(() => translate('t == $0', { model, className: 'S', args: [realm.objects('T')[0]] }), (e) => e instanceof RqlError && /stored property named "constructor"/.test(e.message));
        assert.throws(() => realm.objects('S').filtered('t == $0', realm.objects('T')[0]));
      } finally {
        realm.close();
      }
    }
  }

  // Dictionary keys named like Dictionary or Object.prototype members, and "__proto__".
  const f = path.join(d, 'dict.realm');
  await make(f, [{ name: 'S', primaryKey: 'id', properties: { id: 'int', d: 'int{}', m: 'mixed', md: 'mixed{}' } }], (r) => {
    const s = r.create('S', { id: 1, d: { toString: 5, values: 6, a: 7, set: 8, remove: 9, constructor: 10, keys: 11 }, m: { toString: 1, entries: 2 }, md: { values: 3 } });
    s.d.set({ ['__proto__']: 12 });
  });
  const res = await convert(f, path.join(d, 'dict.sqlite'));
  assert.equal(res.ok, true);
  const row = sqlAll(path.join(d, 'dict.sqlite'), 'SELECT d, m, md FROM "S"')[0];
  assert.equal(row.d, '{"__proto__":12,"a":7,"constructor":10,"keys":11,"remove":9,"set":8,"toString":5,"values":6}');
  assert.equal(row.m, '{"t":"dictionary","v":{"entries":{"t":"number","v":2},"toString":{"t":"number","v":1}}}');
  assert.equal(row.md, '{"values":{"t":"number","v":3}}');
  // The verification sees a lost entry: drop "__proto__" from the stored JSON.
  const bad = await convert(f, path.join(d, 'dict2.sqlite'), { _beforeVerify: (db) => db.exec(`UPDATE "S" SET d = json_remove(d, '$.__proto__')`) });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.verification.mismatches.map((m) => m.fields), [['d']]);

  // A query argument of another class than the link target is refused, as in the SDK.
  const g = path.join(d, 'arg.realm');
  await make(g, [{ name: 'T', primaryKey: 'id', properties: { id: 'int' } }, { name: 'U', primaryKey: 'id', properties: { id: 'int' } }, { name: 'S', primaryKey: 'id', properties: { id: 'int', t: 'T?' } }],
    (r) => { const t = r.create('T', { id: 1 }); r.create('U', { id: 1 }); r.create('S', { id: 1, t }); });
  assert.equal((await convert(g, path.join(d, 'arg.sqlite'))).ok, true);
  const realm = await Realm.open({ path: g, readOnly: true });
  try {
    const model = meta(path.join(d, 'arg.sqlite'), 'model');
    assert.throws(() => realm.objects('S').filtered('t == $0', realm.objects('U')[0]));
    assert.throws(() => translate('t == $0', { model, className: 'S', args: [realm.objects('U')[0]] }), (e) => e instanceof RqlError && /cannot be compared with an object of class U/.test(e.message));
    assert.throws(() => translate('id == $0', { model, className: 'S', args: [realm.objects('U')[0]] }), RqlError);
  } finally {
    realm.close();
  }
});

test('backlinks computed from the forward links equal the SDK linkingObjects()', async () => {
  const d = tmpDir('reg-blidx');
  const all = path.join(d, 'all.realm');
  await makeAllTypes(all, { n: 60 });
  const T = { name: 'T', properties: { v: 'int' } };
  const S = { name: 'S', primaryKey: 'id', properties: { id: 'int', t: 'T?', ts: 'T[]', td: 'T{}', tset: 'T<>' } };
  const dup = path.join(d, 'dup.realm');
  await make(dup, [T, S], (r) => {
    const t = [0, 1, 2].map((v) => r.create('T', { v }));
    r.create('S', { id: 1, t: t[0], ts: [t[0], t[0], t[1]], td: { a: t[0], b: t[0], c: null }, tset: [t[0], t[1]] });
    r.create('S', { id: 2, t: t[0], ts: [t[1]], td: { a: t[1] } });
  });
  const bl = (p) => ({ type: 'linkingObjects', objectType: 'S', property: p });
  const dupApp = [{ ...T, properties: { ...T.properties, srcs: bl('t'), inLists: bl('ts'), inDicts: bl('td'), inSets: bl('tset') } }, S];
  for (const [src, app] of [[all, allTypesSchema], [dup, dupApp]]) {
    const out = src.replace(/\.realm$/, '.sqlite');
    const rep = await convert(src, out, { schema: app });
    assert.equal(rep.ok, true);
    const model = meta(out, 'model');
    const realm = await Realm.open({ path: src, readOnly: true });
    try {
      indexClasses(realm);
      const index = await backlinkIndex(realm, model);
      let compared = 0;
      for (const t of Object.values(model.classes)) {
        for (const [n, desc] of Object.entries(t.props)) {
          if (desc.kind !== 'backlink') continue;
          for (const obj of realm.objects(t.name)) {
            const sdk = [...Realm.Object.prototype.linkingObjects.call(obj, desc.source, desc.sourceProp)].map((o) => keyR(model, desc.source, o)).sort(cmpKey);
            assert.deepEqual(index(desc, t.name, obj), sdk, `${t.name}.${n}`);
            compared += sdk.length;
          }
        }
      }
      assert.ok(compared > 10, `compared ${compared} backlinks`);
    } finally {
      realm.close();
    }
  }
});

test('nan, inf and infinity are constants as in the SDK: same results or a clear refusal', async () => {
  const d = tmpDir('reg-nan');
  const schema = [
    { name: 'L', primaryKey: 'id', properties: { id: 'int', d: 'double', i: 'int?' } },
    { name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int', io: 'int?', d: 'double', dopt: 'double?', f: 'float', s: 'string?', b: 'bool', t: 'date', dl: 'double[]', il: 'int[]', l: 'L?', NaN: 'int', inf: 'int', Infinity: 'double' } },
  ];
  const src = path.join(d, 'nan.realm');
  await make(src, schema, (r) => {
    [0, 1, -1, NaN, Infinity, -Infinity, 2.5].forEach((v, k) => {
      const l = k === 6 ? null : r.create('L', { id: k, d: v, i: k === 2 ? null : k });
      r.create('K', { id: k, i: k - 2, io: k % 2 ? null : k, d: v, dopt: k === 1 ? null : v, f: v, s: k === 3 ? null : 'x' + k, b: k % 2 === 0, t: new Date(k), dl: k === 0 ? [] : [v, 1], il: k === 0 ? [] : [k], l, NaN: k % 2, inf: 1, Infinity: v });
    });
  });
  const out = path.join(d, 'nan.sqlite');
  assert.equal((await convert(src, out)).ok, true);
  const model = meta(out, 'model');
  const realm = await Realm.open({ path: src, readOnly: true });
  const db = new Database(out, { readonly: true });
  try {
    const tally = { same: 0, bothRefused: 0, refused: [], diff: [] };
    const check = (query, args) => {
      const [sdk, sql] = both(realm, db, model, 'K', query, args);
      if (Array.isArray(sdk) && Array.isArray(sql) && JSON.stringify(sdk) === JSON.stringify(sql)) tally.same++;
      else if (sdk === 'error' && (sql === 'RqlError' || sql === 'Unsupported')) tally.bothRefused++;
      else if (sql === 'Unsupported') tally.refused.push(query);
      else tally.diff.push(`${query} ${JSON.stringify(args ?? [])}: SDK ${JSON.stringify(sdk)} SQL ${JSON.stringify(sql)}`);
    };
    const props = ['i', 'io', 'd', 'dopt', 'f', 's', 'b', 't', 'dl', 'il', 'l.d', 'l.i', 'l', 'dl.@count', 's.@size'];
    for (const p of props) {
      for (const c of ['nan', 'NaN', '-nan', '+nan', 'inf', '-inf', '+inf', 'Infinity', '-INFINITY', 'iNf']) {
        for (const op of ['==', '!=', '<', '<=', '>', '>=']) { check(`${p} ${op} ${c}`); check(`${c} ${op} ${p}`); }
      }
      for (const a of [NaN, Infinity, -Infinity]) for (const op of ['==', '!=', '<', '>']) { check(`${p} ${op} $0`, [a]); check(`$0 ${op} ${p}`, [a]); }
    }
    // Constants on the left of a base double: the SDK orders NaN below every number.
    for (const query of ['1 > d', '1.0 > d', '2.5 >= dopt', '0 == d', 'd IN {nan, 1.5}', 'd IN {inf, 1.5}', 'ANY dl == inf', 'ALL dl == nan', 'NONE dl < -inf', 'ANY il > nan', 'ALL il >= nan',
      'd == ANY {inf, nan}', 'NaN == 1', 'l.inf == 1', 'inf.x == 1', 'Infinity > 0', 'd > 1 AND NOT d == inf', 'i IN {inf}', 'i IN {nan}']) check(query);
    assert.deepEqual(tally.diff, []);
    assert.deepEqual(tally.refused, ['i IN {nan}']);
    assert.ok(tally.same > 1000 && tally.bothRefused > 1000, JSON.stringify({ same: tally.same, bothRefused: tally.bothRefused }));
    // quirks: false gives the plain meaning: "1.0 > d" is "d < 1.0".
    const plain = (query) => { const t = translate(query, { model, className: 'K', quirks: false }); return db.prepare(t.sql).pluck().all(...t.params).sort((x, y) => x - y); };
    assert.deepEqual(plain('1.0 > d'), plain('d < 1.0'));
    assert.deepEqual(both(realm, db, model, 'K', '1.0 > d'), [[0, 2, 3, 5], [0, 2, 3, 5]]);
    // A property named NaN, inf or Infinity cannot be named in a query, as in the SDK.
    assert.deepEqual(both(realm, db, model, 'K', 'NaN == 1'), ['error', 'RqlError']);
    assert.deepEqual(both(realm, db, model, 'K', 'i == NaN'), [[], []]);
  } finally {
    db.close();
    realm.close();
  }
});

test('translate() refuses class names inherited from Object.prototype with RqlError', () => {
  const model = { version: 1, embedded: {}, renames: [], classes: { A: { name: 'A', table: 'A', key: { column: 'id', type: 'int', synthetic: false }, props: { id: { kind: 'scalar', type: 'int', column: 'id' } }, columns: [], lists: [], views: [] } } };
  for (const cn of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'Nope', undefined]) {
    assert.throws(() => translate('id == 1', { model, className: cn }), (e) => e instanceof RqlError && e.message === `unknown class ${cn}`, String(cn));
  }
  // A property the model does not know: RqlError when the model was built with
  // the app schema (--schema); without it the name may be a backlink or a public
  // mapTo name of the app, so Unsupported (a caller falls back to the SDK).
  assert.throws(() => translate('toString == 1', { model: { ...model, appSchema: true }, className: 'A' }), (e) => e instanceof RqlError && !(e instanceof Unsupported));
  assert.throws(() => translate('toString == 1', { model, className: 'A' }), (e) => e instanceof Unsupported && /unknown property A\.toString/.test(e.message));
  assert.equal(translate('id == 1', { model, className: 'A' }).sql, 'SELECT b."id" FROM "A" b WHERE IFNULL(b."id" = ?, 0)');
});

// ---------- third adversarial pass: files, CLI, signals ----------

// Leftovers of a run anywhere under d: temporary files (afterdb.<12 hex>.partial and
// its SQLite side files, the private copy afterdb.<12 hex>.copy/, .report.json.<12 hex>.tmp)
// and old reports moved aside (.old).
const leftovers = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => /\.[0-9a-f]{12}\.(partial|tmp|old|copy)(-journal|-wal|-shm)?$/.test(f));
const oldReport = (rep) => {
  fs.mkdirSync(rep, { recursive: true });
  fs.writeFileSync(path.join(rep, 'report.json'), '{"old":true}');
  fs.writeFileSync(path.join(rep, 'report.md'), '# OLD REPORT');
};
const assertOldReport = (rep, msg) => {
  assert.equal(fs.readFileSync(path.join(rep, 'report.json'), 'utf8'), '{"old":true}', msg);
  assert.equal(fs.readFileSync(path.join(rep, 'report.md'), 'utf8'), '# OLD REPORT', msg);
};

test('an error after the report is written leaves the old report and the old output as they were', async () => {
  const d = tmpDir('reg-oldrep');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const sub = (n) => { const x = path.join(d, n); fs.mkdirSync(x); return x; };

  // A: the output appears during the run, no --force.
  let x = sub('a');
  let out = path.join(x, 'o.sqlite');
  let rep = path.join(x, 'rep');
  oldReport(rep);
  await assert.rejects(convert(inp, out, { report: rep, _beforeVerify: () => fs.writeFileSync(out, 'SOMEONE ELSE') }), /output exists: .*created during the conversion/);
  assertOldReport(rep);
  assert.equal(fs.readFileSync(out, 'utf8'), 'SOMEONE ELSE');
  assert.deepEqual(ls(x), ['o.sqlite', 'rep']);
  assert.deepEqual(ls(rep), ['report.json', 'report.md']);

  // B: the old output cannot be replaced (macOS "Locked" flag), --force: the
  // database rename fails after the reports were renamed; they are moved back.
  if (process.platform === 'darwin' && process.getuid?.() !== 0) {
    x = sub('b');
    out = path.join(x, 'o.sqlite');
    rep = path.join(x, 'rep');
    oldReport(rep);
    fs.writeFileSync(out, 'OLD LOCKED');
    spawnSync('chflags', ['uchg', out]);
    try {
      const r = cli([inp, out, '--force', '--report', rep]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /cannot replace .*o\.sqlite: EPERM/);
      assertOldReport(rep);
      assert.equal(fs.readFileSync(out, 'utf8'), 'OLD LOCKED');
      assert.deepEqual(ls(x), ['o.sqlite', 'rep']);
      assert.deepEqual(ls(rep), ['report.json', 'report.md']);
    } finally {
      spawnSync('chflags', ['nouchg', out]);
    }
  }

  // C: two runs with the same output and report folder, no --force. Run 2 runs
  // completely while run 1 is verifying; run 1 then fails ("output exists") and
  // must not delete or replace run 2's report.
  x = sub('c');
  out = path.join(x, 'o.sqlite');
  rep = path.join(x, 'rep');
  const inp2 = path.join(d, 'app2.realm');
  await make(inp2, SCHEMA, fill(7));
  let run2;
  await assert.rejects(convert(inp, out, { report: rep, _beforeVerify: () => { run2 = cli([inp2, out, '--report', rep]); } }), /output exists: .*created during the conversion/);
  assert.equal(run2.status, 0, run2.stdout + run2.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rep, 'report.json'), 'utf8')).input.path, inp2);
  assert.match(fs.readFileSync(path.join(rep, 'report.md'), 'utf8'), /app2\.realm/);
  assert.equal(sqlAll(out, 'SELECT count(*) AS n FROM "A"')[0].n, 7);
  assert.deepEqual(ls(x), ['o.sqlite', 'rep']);
  assert.deepEqual(ls(rep), ['report.json', 'report.md']);

  // D: <out> is rep/Report.json, a case variant of the new report.json (seen
  // only once both exist, on a case-insensitive disk): the old report.md stays.
  x = sub('d');
  fs.writeFileSync(path.join(x, 'probe'), '');
  if (fs.existsSync(path.join(x, 'PROBE'))) {
    rep = path.join(x, 'rep');
    fs.mkdirSync(rep);
    fs.writeFileSync(path.join(rep, 'report.md'), '# OLD REPORT');
    const r = cli([inp, path.join(rep, 'Report.json'), '--report', rep]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Report\.json is the same file as .*report\.json/);
    assert.deepEqual(ls(rep), ['report.md']);
    assert.equal(fs.readFileSync(path.join(rep, 'report.md'), 'utf8'), '# OLD REPORT');
  }

  // E: without --force, <out> is created first (link); the old report.md is
  // locked during the run, so moving it aside fails afterwards: the new <out> is
  // deleted again and the old report.json is moved back.
  if (process.platform === 'darwin' && process.getuid?.() !== 0) {
    x = sub('e');
    out = path.join(x, 'o.sqlite');
    rep = path.join(x, 'rep');
    oldReport(rep);
    const md = path.join(rep, 'report.md');
    try {
      await assert.rejects(convert(inp, out, { report: rep, _beforeVerify: () => spawnSync('chflags', ['uchg', md]) }), /EPERM/);
      assertOldReport(rep);
      assert.deepEqual(ls(x), ['rep']);
      assert.deepEqual(ls(rep), ['report.json', 'report.md']);
    } finally {
      spawnSync('chflags', ['nouchg', md]);
    }
  }

  // F: four runs at the same time, same output and report folder, an old
  // report, no --force: one gets <out>, its report is the one left, nothing else.
  for (let round = 0; round < 3; round++) {
    x = sub('f' + round);
    out = path.join(x, 'o.sqlite');
    rep = path.join(x, 'rep');
    oldReport(rep);
    const ins = [inp, inp2, inp, inp2];
    const runs = await Promise.all(ins.map((f) => new Promise((res) => {
      const p = spawn(process.execPath, [BIN, f, out, '--report', rep]);
      p.on('exit', (code) => res(code));
    })));
    assert.equal(runs.filter((c) => c === 0).length, 1, `round ${round}: exits ${runs}`);
    assert.deepEqual(runs.filter((c) => c !== 0 && c !== 1), []);
    const won = ins[runs.indexOf(0)];
    assert.equal(JSON.parse(fs.readFileSync(path.join(rep, 'report.json'), 'utf8')).input.path, won);
    assert.equal(sqlAll(out, 'SELECT count(*) AS n FROM "A"')[0].n, won === inp ? 50 : 7);
    assert.deepEqual(ls(x), ['o.sqlite', 'rep']);
    assert.deepEqual(ls(rep), ['report.json', 'report.md']);
  }

  // A run that succeeds replaces the old report and leaves nothing else.
  x = sub('ok');
  rep = path.join(x, 'rep');
  oldReport(rep);
  assert.equal((await convert(inp, path.join(x, 'o.sqlite'), { report: rep })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rep, 'report.json'), 'utf8')).ok, true);
  assert.deepEqual(ls(rep), ['report.json', 'report.md']);
  assert.deepEqual(leftovers(d), []);
});

test('an option value that is another option is refused: --report --force does not create a folder "--force"', async () => {
  const d = tmpDir('reg-optval');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(20));
  const cwd = path.join(d, 'cwd');
  fs.mkdirSync(cwd);
  for (const old of [true, false]) {
    if (old) fs.writeFileSync(path.join(cwd, 'o.sqlite'), 'OLD');
    else fs.rmSync(path.join(cwd, 'o.sqlite'));
    const r = spawnSync(process.execPath, [BIN, inp, 'o.sqlite', '--report', '--force'], { encoding: 'utf8', cwd });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--report needs a value, got the option --force/);
    assert.deepEqual(ls(cwd), old ? ['o.sqlite'] : []);
  }
  for (const opt of ['--schema', '--key', '--sample', '--batch', '--report']) {
    for (const v of ['--force', '--help', '-h']) {
      const r = spawnSync(process.execPath, [BIN, inp, 'o.sqlite', opt, v], { encoding: 'utf8', cwd });
      assert.equal(r.status, 1, `${opt} ${v}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${opt} needs a value, got the option ${v}`));
    }
    const r = spawnSync(process.execPath, [BIN, inp, 'o.sqlite', opt], { encoding: 'utf8', cwd });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${opt} needs a value`));
  }
  assert.deepEqual(ls(cwd), []);
  // A folder whose name starts with "--" is still possible as ./--name.
  const r = spawnSync(process.execPath, [BIN, inp, 'o.sqlite', '--report', './--force'], { encoding: 'utf8', cwd });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(ls(path.join(cwd, '--force')), ['report.json', 'report.md']);
});

test('convert(): report false, null or undefined means no report; an empty or non-string report is refused without naming a CLI flag', async () => {
  const d = tmpDir('reg-apirep');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(10));
  for (const [i, report] of [false, null, undefined].entries()) {
    const r = await convert(inp, path.join(d, `o${i}.sqlite`), { report });
    assert.equal(r.ok, true);
  }
  for (const report of ['', 0, true, {}]) {
    await assert.rejects(convert(inp, path.join(d, 'bad.sqlite'), { report }), (e) => /report must be a folder name/.test(e.message) && !e.message.includes('--report'));
  }
  assert.deepEqual(ls(d), ['app.realm', 'o0.sqlite', 'o1.sqlite', 'o2.sqlite']);
});

test('a source that fails to open (not a realm file, wrong or missing key) leaves no temporary file; the tool deletes no SDK file', async () => {
  const d = tmpDir('reg-badsrc');
  const out = path.join(d, 'o.sqlite');
  fs.writeFileSync(out, 'OLD');
  const garbage = path.join(d, 'garbage.realm');
  fs.writeFileSync(garbage, 'not a realm file '.repeat(500));
  const enc = path.join(d, 'enc.realm');
  const key = Buffer.alloc(64, 7);
  const r0 = await Realm.open({ path: enc, schema: SCHEMA, encryptionKey: key });
  r0.write(() => fill(5)(r0));
  r0.close();
  for (const s of ['.lock', '.note', '.management']) fs.rmSync(enc + s, { recursive: true, force: true });
  const cases = [[garbage, {}], [enc, { key: 'ab'.repeat(64) }], [enc, {}]];
  for (const [inp, opts] of cases) {
    await assert.rejects(convert(inp, out, { force: true, report: path.join(d, 'rep'), ...opts }));
    assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
    assert.deepEqual(ls(d).filter((f) => !f.endsWith('.realm.lock') && !f.endsWith('.realm.note') && !f.endsWith('.realm.management')), ['enc.realm', 'garbage.realm', 'o.sqlite']);
    assert.deepEqual(leftovers(d), [], `${path.basename(inp)} ${JSON.stringify(opts)}`);
  }
  // The CLI the same way. (The tool never deletes the files the SDK keeps next
  // to an input, see the next test; after a failed open the SDK leaves none.)
  const r = cli([enc, out, '--force', '--key', 'cd'.repeat(64)]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(ls(d), ['enc.realm', 'garbage.realm', 'o.sqlite']);
  assert.deepEqual(leftovers(d), []);
});

// A hook that slows every insert of class A down by `ms` once `after` rows are in,
// and sends `sig` to the process at that point (time written to `mark`).
const slowHook = (d, { after = 200, ms = 2, sig = 'SIGINT', mark }) => {
  const hook = path.join(d, 'slow-hook.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';
import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('better-sqlite3');
const orig = Database.prototype.prepare;
let n = 0;
Database.prototype.prepare = function (sql) {
  const st = orig.call(this, sql);
  if (sql.startsWith('INSERT INTO "A"')) {
    const run = st.run;
    st.run = function (...a) {
      if (++n === ${after}) { ${mark ? `fs.writeFileSync(${JSON.stringify(mark)}, String(Date.now()));` : ''} ${sig ? `process.kill(process.pid, '${sig}');` : ''} }
      if (n >= ${after}) { const t = performance.now(); while (performance.now() - t < ${ms}); }
      return run.apply(this, a);
    };
  }
  return st;
};
`);
  return ['--import', pathToFileURL(hook).href];
};

test('an interrupt is handled within a fraction of a second, even inside a large batch', async () => {
  const d = tmpDir('reg-siglat');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(5000));
  const out = path.join(d, 'o.sqlite');
  fs.writeFileSync(out, 'OLD');
  const mark = path.join(d, 'mark');
  // One transaction of 5000 objects at 2 ms each after the signal: about 10 s if
  // the handler had to wait for the end of the batch.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const r = cli([inp, out, '--force', '--batch', '5000', '--report', path.join(d, 'rep')], slowHook(d, { sig, mark }));
    const latency = Date.now() - Number(fs.readFileSync(mark, 'utf8'));
    assert.equal(r.signal, sig, `status ${r.status}: ${r.stdout}${r.stderr}`);
    assert.ok(latency < 2000, `${sig} handled after ${latency} ms`);
    assert.match(r.stderr, new RegExp(`interrupted \\(${sig}\\)`));
    assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
    fs.rmSync(mark);
    assert.deepEqual(ls(d), ['app.realm', 'o.sqlite', 'slow-hook.mjs']);
  }
});

test('Ctrl-C stops a shell script that runs afterdb-convert in a loop (bash and sh)', async () => {
  const d = tmpDir('reg-sigloop');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(2000));
  const hook = slowHook(d, { after: 1, ms: 5, sig: null });
  for (const shell of ['/bin/bash', '/bin/sh']) {
    if (!fs.existsSync(shell)) continue;
    const script = path.join(d, 'loop.sh');
    const q = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(script, `NODE=${q(process.execPath)}; HOOK=${q(hook[1])}; BIN=${q(BIN)}; IN=${q(inp)}; D=${q(d)}
for i in 1 2; do
  echo "start $i"
  "$NODE" --import "$HOOK" "$BIN" "$IN" "$D/o$i.sqlite"
  echo "after $i rc=$?"
done
echo END
`);
    const p = spawn(shell, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    p.stdout.on('data', (b) => (output += b));
    p.stderr.on('data', (b) => (output += b));
    // Ctrl-C in a terminal sends SIGINT to the whole foreground process group.
    const started = Date.now();
    while (!fs.readdirSync(d).some((f) => /^afterdb\.[0-9a-f]{12}\.partial$/.test(f))) {
      assert.ok(Date.now() - started < 20_000, `${shell}: the conversion did not start: ${output}`);
      await new Promise((res) => setTimeout(res, 20));
    }
    await new Promise((res) => setTimeout(res, 200));
    process.kill(-p.pid, 'SIGINT');
    const [code, signal] = await new Promise((res) => p.on('exit', (c, s) => res([c, s])));
    assert.doesNotMatch(output, /start 2|END/, `${shell}: ${output}`);
    assert.match(output, /interrupted \(SIGINT\)/, `${shell}: ${output}`);
    assert.ok(signal === 'SIGINT' || code !== 0, `${shell}: exit ${code} ${signal}`);
    assert.deepEqual(ls(d), ['app.realm', 'loop.sh', 'slow-hook.mjs'], shell);
  }
});

// ---------- third adversarial pass: query translator ----------

// A converted file with both sides open: the SDK (with the app schema, for
// backlinks) and the SQLite output.
async function sdkSql(name, schema, fill, appSchema) {
  const d = tmpDir(name);
  const src = path.join(d, 'k.realm');
  const out = path.join(d, 'k.sqlite');
  await make(src, schema, fill);
  const r = await convert(src, out, appSchema ? { schema: appSchema } : {});
  assert.equal(r.ok, true);
  const db = new Database(out, { readonly: true });
  const model = JSON.parse(db.prepare('SELECT "value" FROM "_afterdb_meta" WHERE "key" = \'model\'').pluck().get());
  const realm = await Realm.open({ path: src, readOnly: true, ...(appSchema ? { schema: appSchema } : {}) });
  return { realm, db, model, close() { realm.close(); db.close(); } };
}

/**
 * Each query on the SDK and through the translator. Allowed: the same ids (in
 * the same order with SORT), or a refusal (RqlError / Unsupported) where the SDK
 * fails too. Queries in `unsupported` (a list of queries, or a function of the
 * query and its arguments) must raise Unsupported. With `strict`, a query the
 * SDK refuses must raise RqlError (not Unsupported). Returns the count of
 * queries the SDK answered.
 */
function agree(ctx, cls, queries, { unsupported = [], quirks = true, strict = false } = {}) {
  let answered = 0;
  for (const item of queries) {
    const [query, args = []] = Array.isArray(item) ? item : [item];
    const sorted = /\bSORT\s*\(/i.test(query);
    const order = (a) => (sorted ? a : a.sort((x, y) => x - y));
    let sdk;
    try { sdk = order(Array.from(ctx.realm.objects(cls).filtered(query, ...args), (o) => o.id)); answered++; } catch { sdk = 'error'; }
    let sql;
    try {
      const t = translate(query, { model: ctx.model, className: cls, args, quirks });
      sql = order(ctx.db.prepare(t.sql).pluck().all(...t.params));
    } catch (e) {
      sql = e instanceof Unsupported ? 'Unsupported' : e instanceof RqlError ? 'RqlError' : `CRASH ${e.constructor.name}: ${e.message}`;
    }
    // (toJSON runs before the replacer: look at the original value, this[k].)
    const label = `${query} ${JSON.stringify(args, function (k, v) { return typeof v === 'bigint' ? `${v}n` : this[k] instanceof Realm.Object ? `object ${this[k].id}` : v; })}`;
    const refused = typeof unsupported === 'function' ? unsupported(query, args) : unsupported.includes(query);
    if (refused) assert.equal(sql, 'Unsupported', label);
    else if (sdk === 'error') assert.ok(sql === 'RqlError' || (!strict && sql === 'Unsupported'), `${label}: the SDK refuses it, the translator gives ${JSON.stringify(sql)}`);
    else assert.deepEqual(sql, sdk, label);
  }
  return answered;
}

test('names as in the SDK lexer: non-ASCII letters, $ and -, keyword casing, keywords used as names, [c] only', async () => {
  const names = ['prénom', 'âge', 'naïf', 'prix$', 'x-1', 'nané', 'inf$x', 'Not', 'In', 'Any', 'All', 'None', 'Some', 'in', 'sort', 'limit', 'like', 'contains', 'asc', 'desc', 'between', 'True'];
  const schema = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int', s: 'string?', l: 'K?', ls: 'K[]', ...Object.fromEntries(names.map((n) => [n, 'int'])) } }];
  const ctx = await sdkSql('reg-lexnames', schema, (r) => {
    const o = [];
    for (let k = 0; k < 8; k++) o.push(r.create('K', { id: k, i: k % 4, s: ['a', 'A', 'b', null][k % 4], ...Object.fromEntries(names.map((n, j) => [n, (k + j) % 3])) }));
    o.forEach((x, k) => { x.l = o[(k + 1) % 8]; x.ls = [o[(k + 2) % 8], o[(k + 3) % 8]]; });
  });
  try {
    const Q = [];
    for (const n of names) Q.push(`${n} == 1`, `l.${n} == 1`, `i == ${n}`, `${n} > 0 AND i == 1`, `i == 1 SORT(${n} ASC)`, `${n} IN {1, 2}`);
    Q.push('Not i > 2', 'not i > 2', 'NOT i > 2', 'Any ls.i > 2', 'any ls.i > 2', 'SOME ls.i > 2', 'Some ls.i > 2', 'All ls.i > 2', 'None ls.i > 2', 'i In {1, 2}', 'i in {1, 2}',
      'i > 0 aNd i < 3', 'i == 0 Or i == 1', 's == Null', 's == nIL', 'TruePredicate', 'i > 1 SORT(i Desc) Limit(3)', 'i =< 1', 'i => 2',
      's ==[c] "a"', 's ==[C] "a"', 's ==[cc] "a"', 's ==[d] "a"', 's ==[cd] "a"', 's BEGINSWITH[C] "a"', 'ANY "b" > ls.s', 'id\u00a0== 1', 'id\f== 1', 'ls.@count == 2', 'ls.@COUNT == 2', 's.@count == 1');
    assert.equal(agree(ctx, 'K', Q), 148);
  } finally {
    ctx.close();
  }
});

test('string literals keep backslash escapes as typed, as in the SDK; escapes the SDK refuses are RqlError', async () => {
  const S = ['a', 'a\\nb', 'a\nb', "it's", "it\\'s", 'a"b', 'a\\"b', 'a\\b', 'a\\\\b', 'x\ty', 'x\\ty', 'é', '\\u00e9', 'ab', 'a\rb', 'a\\rb', 'a/b', 'a\\/b', 'u\\x41', 'uA', 'a\\', '\\', '\\\\', 'a\bb', 'a\fb', 'a\\0b', 'a\vb', 'C:\\Users', 'C:\\\\Users', 'path\\to', '\\uD83D\\uDE00', '😀'];
  const ctx = await sdkSql('reg-escapes', [{ name: 'K', primaryKey: 'id', properties: { id: 'int', s: 'string?' } }], (r) => S.forEach((s, id) => r.create('K', { id, s })));
  try {
    const R = String.raw;
    const Q = [R`s == "a\nb"`, R`s == "a\\nb"`, R`s == 'it\'s'`, R`s == "it's"`, R`s == "a\"b"`, R`s == 'a"b'`, R`s == "a\\b"`, R`s == "a\\\\b"`, R`s == "x\ty"`, R`s == "x\\ty"`,
      R`s == "\u00e9"`, R`s == "\u00E9"`, R`s == "é"`, R`s == "a\rb"`, R`s == "a\/b"`, R`s == "a/b"`, R`s == "a\b"`, R`s == "a\fb"`, R`s == "a\0b"`, R`s == "\\"`, R`s == "\\\\"`,
      R`s == "C:\\Users"`, R`s == "C:\Users"`, R`s == "path\to"`, R`s == "\uD83D\uDE00"`, R`s BEGINSWITH "C:\\"`, R`s CONTAINS "\n"`, R`s ENDSWITH "\\"`, R`s LIKE "a\\*"`, R`s LIKE "*\\*"`, R`s ==[c] "IT\'S"`,
      R`s == "u\x41"`, R`s == "a\vb"`, R`s == "a\qb"`, R`s LIKE "a\*b"`, R`s == "\u{41}"`, R`s == "\u00e"`, R`s ==[c] "A\NB"`, R`s == "a\é"`, R`s == "a\"`];
    assert.equal(agree(ctx, 'K', Q), 30);
    for (const q of [R`s == "u\x41"`, R`s == "a\qb"`, R`s == "\u{41}"`]) assert.throws(() => translate(q, { model: ctx.model, className: 'K' }), /invalid escape/);
  } finally {
    ctx.close();
  }
});

test('several SORT clauses: the last one is the primary order, as in the SDK; a SORT after a LIMIT is refused', async () => {
  // Inserted in id order: insertion order (SDK ties) is primary key order (SQL ties).
  const ctx = await sdkSql('reg-sorts', [{ name: 'K', primaryKey: 'id', properties: { id: 'int', a: 'int', b: 'int', s: 'string', l: 'K?' } }], (r) => {
    const o = [];
    for (let k = 0; k < 9; k++) o.push(r.create('K', { id: k, a: k % 3, b: (k * 5) % 9, s: 'x' + ((k * 7) % 9) }));
    o.forEach((x, k) => { x.l = k % 4 ? o[(k * 2) % 9] : null; });
  });
  try {
    const unsupported = ['TRUEPREDICATE LIMIT(4) SORT(b ASC)', 'TRUEPREDICATE SORT(b ASC) LIMIT(4) SORT(a ASC)', 'TRUEPREDICATE LIMIT(5) LIMIT(3) SORT(b DESC)', 'id > 2 LIMIT(3) SORT(s DESC)'];
    agree(ctx, 'K', ['TRUEPREDICATE SORT(a ASC, b ASC)', 'TRUEPREDICATE SORT(a ASC) SORT(b ASC)', 'TRUEPREDICATE SORT(b ASC) SORT(a ASC)', 'TRUEPREDICATE SORT(a DESC) SORT(b ASC)',
      'TRUEPREDICATE SORT(b ASC) LIMIT(4)', 'TRUEPREDICATE SORT(a ASC) SORT(a DESC)', 'TRUEPREDICATE SORT(s DESC) SORT(a ASC) SORT(b DESC)', 'TRUEPREDICATE SORT(l.a ASC) SORT(s DESC)',
      'TRUEPREDICATE SORT(s ASC) SORT(l.b DESC)', 'id > 1 SORT(b ASC) LIMIT(6) LIMIT(4)', ...unsupported], { unsupported });
  } finally {
    ctx.close();
  }
});

test('@count/@size after a list: ANY element whose own count or byte size matches; IN with several values there is refused', async () => {
  const schema = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', s: 'string?', i: 'int?', sl: 'string[]', il: 'int[]', ls: 'K[]', l: 'K?' } }];
  const ctx = await sdkSql('reg-counts', schema, (r) => {
    const o = [];
    for (let k = 0; k < 12; k++) o.push(r.create('K', { id: k, s: ['', 'a', 'ab', 'abc', null, 'é'][k % 6], i: k % 4, sl: [[], ['x'], ['x', 'y'], ['x', 'y', 'z']][k % 4], il: Array.from({ length: k % 4 }, () => 1) }));
    o.forEach((x, k) => { x.l = k % 3 === 0 ? null : o[(k + 2) % 12]; x.ls = [[], [o[(k + 1) % 12]], [o[(k + 1) % 12], o[(k + 5) % 12]], [o[(k + 7) % 12], o[(k + 7) % 12], o[(k + 2) % 12]]][k % 4]; });
  });
  try {
    const Q = [];
    for (const p of ['ls.s.@size', 'ls.s.@count', 'ls.sl.@count', 'ls.sl.@size', 'ls.ls.@count', 'l.ls.@count', 'l.sl.@count', 'l.ls.sl.@count', 'ls.l.sl.@count', 'ls.l.s.@size', 'ls.l.ls.@count', 's.@size', 'sl.@count', 'l.s.@size']) {
      for (const c of ['== 0', '== 1', '== 2', '!= 1', '> 1', '<= 2', '== null', '!= null']) Q.push(`${p} ${c}`);
    }
    const unsupported = ['l.ls.@count IN {0, 3}', 'l.sl.@count IN {0, 3}', 'l.ls.@size IN {1, 2}', 'l.l.ls.@count IN {0, 3}', 'ls.sl.@count IN {1, 2}', 'ls.ls.@count IN {0, 3}', 'l.s.@size IN {1, 2}'];
    Q.push('l.ls.@count IN {3}', 'l.ls.@count == ANY {0, 3}', 'sl.@count IN {1, 2}', 's.@size IN {0, 2}', ...unsupported);
    assert.ok(agree(ctx, 'K', Q, { unsupported }) > 100);
    assert.throws(() => translate('l.ls.@count IN $0', { model: ctx.model, className: 'K', args: [[0, 3]] }), Unsupported);
  } finally {
    ctx.close();
  }
});

test('@size of a string through a null link is null, as in the SDK (!= 0 is true, == null is true)', async () => {
  const ctx = await sdkSql('reg-sizenull', [{ name: 'K', primaryKey: 'id', properties: { id: 'int', s: 'string?', ls: 'K[]', l: 'K?' } }], (r) => {
    const o = [];
    for (let k = 0; k < 8; k++) o.push(r.create('K', { id: k, s: [null, '', 'a', 'ab'][k % 4] }));
    o.forEach((x, k) => { x.l = k % 3 === 0 ? null : o[(k + 1) % 8]; x.ls = k % 2 ? [o[k]] : []; });
  });
  try {
    const Q = [];
    for (const op of ['==', '!=', '<', '>', '<=', '>=']) for (const v of ['0', '1', '-1', 'nan', 'null']) Q.push(`l.s.@size ${op} ${v}`, `l.ls.@count ${op} ${v}`, `s.@size ${op} ${v}`);
    assert.ok(agree(ctx, 'K', Q) > 60);
  } finally {
    ctx.close();
  }
});

test('ALL/NONE over two lists of links or backlinks apply to every object reached through both, as in the SDK', async () => {
  const file = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int', sl: 'string[]', ls: 'K[]', l: 'K?' } }];
  const app = [{ name: 'K', primaryKey: 'id', properties: { ...file[0].properties, bk: { type: 'linkingObjects', objectType: 'K', property: 'ls' } } }];
  const ctx = await sdkSql('reg-allnone', file, (r) => {
    const o = [];
    for (let k = 0; k < 12; k++) o.push(r.create('K', { id: k, i: k % 4, sl: [[], ['x'], ['x', 'y'], ['y']][k % 4] }));
    o.forEach((x, k) => { x.l = k % 3 === 0 ? null : o[(k + 2) % 12]; x.ls = [[], [o[(k + 1) % 12]], [o[(k + 1) % 12], o[(k + 5) % 12]], [o[(k + 7) % 12], o[(k + 7) % 12], o[(k + 2) % 12]]][k % 4]; });
  }, app);
  try {
    const Q = [];
    for (const qn of ['ALL', 'NONE', 'ANY']) {
      for (const p of ['ls.ls.i', 'ls.bk.i', 'bk.ls.i', 'bk.bk.i', 'l.ls.i', 'ls.l.i']) for (const c of ['== 1', '< 2', '!= 3', '< 3']) Q.push(`${qn} ${p} ${c}`);
      for (const p of ['ls.sl', 'bk.sl']) for (const c of ['== "x"', '!= "y"']) Q.push(`${qn} ${p} ${c}`);
    }
    assert.equal(agree(ctx, 'K', Q), Q.length);
  } finally {
    ctx.close();
  }
});

test('two key paths: null <= null and null >= null are true, x CONTAINS <null> is true, as in the SDK', async () => {
  const schema = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int?', j: 'int?', s: 'string?', t: 'string?', dt: 'date?', et: 'date?', l: 'K?', m: 'K?' } }];
  const SV = ['a', 'ab', '', null];
  const IV = [1, 2, null];
  const DV = [new Date(0), new Date(1000), null];
  const ctx = await sdkSql('reg-paths', schema, (r) => {
    const o = [];
    let k = 0;
    for (const s of SV) for (const t of SV) o.push(r.create('K', { id: k++, s, t }));
    for (const i of IV) for (const j of IV) o.push(r.create('K', { id: k++, i, j }));
    for (const dt of DV) for (const et of DV) o.push(r.create('K', { id: k++, dt, et }));
    o.forEach((x, n) => { x.l = n % 5 ? o[(n * 3) % o.length] : null; x.m = n % 4 ? o[(n * 7) % o.length] : null; });
  });
  try {
    const Q = [];
    for (const [a, b] of [['s', 't'], ['i', 'j'], ['dt', 'et'], ['l.s', 'm.t'], ['l.i', 'm.j'], ['dt', 'l.dt'], ['s', 'l.t']]) {
      for (const op of ['==', '!=', '<', '<=', '>', '>=']) Q.push(`${a} ${op} ${b}`);
      if (a.endsWith('s')) for (const op of ['CONTAINS', 'CONTAINS[c]', 'BEGINSWITH', 'ENDSWITH', 'BEGINSWITH[c]', 'ENDSWITH[c]']) Q.push(`${a} ${op} ${b}`);
    }
    assert.equal(agree(ctx, 'K', Q), Q.length);
  } finally {
    ctx.close();
  }
});

test('value on the left of a base string property: no null-below rule, as in the SDK (quirks on or off)', async () => {
  const ctx = await sdkSql('reg-flipstr', [{ name: 'K', primaryKey: 'id', properties: { id: 'int', s: 'string?', l: 'K?' } }], (r) => {
    const o = [null, '', 'a', 'b', 'c', null].map((s, id) => r.create('K', { id, s }));
    o.forEach((x, k) => { x.l = o[(k + 1) % 6]; });
  });
  try {
    const Q = [];
    for (const v of ['"b"', '""', 'null']) for (const op of ['<', '<=', '>', '>=', '==', '!=']) Q.push(`${v} ${op} s`, `NOT ${v} ${op} s`, `${v} ${op} l.s`);
    Q.push(['$0 > s', ['b']], ['$0 <= s', [null]]);
    for (const quirks of [true, false]) assert.equal(agree(ctx, 'K', Q, { quirks }), Q.length);
  } finally {
    ctx.close();
  }
});

test('quirks: false gives the plain null meaning on base strings: >= null is == null, CONTAINS null is "not null", BEGINSWITH null is false', async () => {
  const model = { classes: { K: { name: 'K', table: 'K', key: { column: 'id', type: 'int' }, props: { id: { kind: 'scalar', type: 'int', column: 'id' }, s: { kind: 'scalar', type: 'string', column: 's' } } } }, embedded: {} };
  const db = new Database(':memory:');
  db.exec('CREATE TABLE "K" ("id" INTEGER PRIMARY KEY, "s" TEXT)');
  [null, '', 'a', 'b'].forEach((s, id) => db.prepare('INSERT INTO "K" VALUES (?, ?)').run(id, s));
  const run = (query, quirks) => { const t = translate(query, { model, className: 'K', quirks }); return db.prepare(t.sql).pluck().all(...t.params).sort(); };
  const plain = { 's >= null': [0], 's > null': [], 's <= null': [0], 's < null': [], 's CONTAINS null': [1, 2, 3], 's BEGINSWITH null': [], 's ENDSWITH null': [], 's LIKE null': [0], 's < "b"': [1, 2] };
  const quirky = { 's >= null': [0, 1, 2, 3], 's > null': [1, 2, 3], 's CONTAINS null': [0, 1, 2, 3], 's BEGINSWITH null': [0, 1, 2, 3], 's ENDSWITH null': [0, 1, 2, 3], 's < "b"': [0, 1, 2] };
  for (const [q, ids] of Object.entries(plain)) assert.deepEqual(run(q, false), ids, `quirks false: ${q}`);
  for (const [q, ids] of Object.entries(quirky)) assert.deepEqual(run(q, true), ids, `quirks true: ${q}`);
  db.close();
});

test('arguments: Decimal128, arrays, non-list IN arguments and wrong types give SDK rows or RqlError/Unsupported, never a bind error', async () => {
  const { Decimal128, ObjectId, UUID } = Realm.BSON;
  const schema = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int?', d: 'double?', f: 'float?', b: 'bool?', s: 'string?', t: 'date?', o: 'objectId?', u: 'uuid?', l: 'K?', ls: 'K[]', il: 'int[]', sl: 'string[]' } }];
  const oid = new ObjectId('507f191e810c19729de860ea');
  const uid = new UUID('3b241101-e2bb-4255-8caf-4136c566a962');
  const ctx = await sdkSql('reg-args', schema, (r) => {
    const o = [];
    for (let k = 0; k < 5; k++) o.push(r.create('K', { id: k, i: k === 4 ? null : k, d: [0.1, 0.5, 1e300, 2, null][k], f: [0.1, 0.5, 3, 2, null][k], b: k % 2 === 0, s: ['a', 'b', 'ab', '1', null][k], t: new Date(k * 1000), o: k === 0 ? oid : null, u: k === 0 ? uid : null, il: [k, 5], sl: ['x' + k] }));
    o.forEach((x, k) => { x.l = o[(k + 1) % 5]; x.ls = [o[(k + 2) % 5]]; });
  });
  try {
    const D = (x) => Decimal128.fromString(x);
    const Q = [];
    for (const v of ['2', '2.0', '2.5', '0.1', '0.5', '1E+300', '1E+400', 'NaN', '9007199254740993']) for (const p of ['i', 'd', 'f']) for (const op of ['==', '<', '>']) Q.push([`${p} ${op} $0`, [D(v)]]);
    for (const [q, a] of [['i == $0', [1, 2]], ['i != $0', [1, 2]], ['i > $0', [1, 2]], ['i < $0', [1, 2]], ['s == $0', ['a', 'b']], ['s BEGINSWITH $0', ['a', 'b']], ['i == $0', []], ['i != $0', []], ['l.i == $0', [1, 2]],
      ['i == $0', [[1]]], ['i IN $0', 5], ['i IN $0', null], ['s IN $0', 'ab'], ['s IN $0', ['ab']], ['i IN $0', [1, 2]], ['i == $0', {}], ['i == $0', new Set([1])], ['i == $0', 2n], ['i == $0', 9007199254740993n],
      ['b == $0', 1], ['b == $0', true], ['i == $0', true], ['i == $0', new Date(1000)], ['t == $0', 1000], ['t == $0', new Date(1000)], ['o == $0', '507f191e810c19729de860ea'], ['o == $0', oid], ['u == $0', '3b241101-e2bb-4255-8caf-4136c566a962'], ['u == $0', uid],
      ['s == $0', 1], ['s == $0', D('1')], ['l == $0', 2], ['d == $0', new Uint8Array([1]).buffer], ['i == $0', undefined]]) Q.push([q, [a]]);
    for (const q of ['b == 1', 'b == 0', 'i == true', 't == 1000', 'o == "507f191e810c19729de860ea"', 'u == "3b241101-e2bb-4255-8caf-4136c566a962"', 'ls == nil', 'ls.l == null', 'ls == null', 'ANY ls.l == null', 's == 1', 'sl == 1', 'i CONTAINS "1"', 'i CONTAINS null', 'il CONTAINS null']) Q.push(q);
    Q.push(['i IN $0', [[D('1'), 2]]], ['i IN {$0, 3}', [D('1')]]);
    // Refused: Decimal128 in IN (the SDK never matches it with an int), a large
    // integer Decimal128 against an int (not exact as a double), an array
    // argument through a list, a string against a number property.
    const unsupported = (q, [a]) => /IN/.test(q) && (a instanceof Decimal128 || (Array.isArray(a) && a.some((x) => x instanceof Decimal128))) ||
      (a instanceof Decimal128 && a.toString() === 'NaN') || (q.startsWith('i ') && a instanceof Decimal128 && ['1E+300', '1E+400', '9007199254740993'].includes(a.toString()));
    const n = agree(ctx, 'K', Q, { unsupported });
    assert.equal(n, 101);
  } finally {
    ctx.close();
  }
});

test('NUL characters: BEGINSWITH, ENDSWITH, CONTAINS and @size see the whole string; LIKE with a NUL in the pattern is refused', async () => {
  const S = ['a\0b', 'a\0', '\0', 'ab', 'a', 'b\0a', 'xa\0bx', 'A\0B', ''];
  const ctx = await sdkSql('reg-nul', [{ name: 'K', primaryKey: 'id', properties: { id: 'int', s: 'string?' } }], (r) => S.forEach((s, id) => r.create('K', { id, s })));
  try {
    const Q = ['s ENDSWITH "b"', 's ENDSWITH "a"', 's BEGINSWITH "a"', 's BEGINSWITH "b"', 's CONTAINS "b"', 's CONTAINS[c] "B"', 's ENDSWITH[c] "B"', 's BEGINSWITH ""', 's ENDSWITH ""', 's CONTAINS ""',
      's.@size == 3', 's.@size == 1', 's ==[c] "ab"', 's > "a"', 's LIKE "a*"', 's LIKE "*"',
      ['s == $0', ['a\0b']], ['s BEGINSWITH $0', ['a\0']], ['s ENDSWITH $0', ['\0b']], ['s CONTAINS $0', ['\0']], ['s ==[c] $0', ['A\0b']], ['s BEGINSWITH[c] $0', ['A\0']], ['s ENDSWITH $0', ['a\0']]];
    assert.equal(agree(ctx, 'K', Q), Q.length);
    assert.throws(() => translate('s LIKE $0', { model: ctx.model, className: 'K', args: ['a\0*'] }), Unsupported);
  } finally {
    ctx.close();
  }
});

// ---------- fourth adversarial pass ----------

// A helper process that opens a realm read-write, as the app would, then
// follows commands given as files in `dir`: P waits for "go", then holds a write
// transaction for `hold` ms; Q writes one object at once.
const appProcess = (d) => {
  const f = path.join(d, 'app-process.mjs');
  fs.writeFileSync(f, `import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const Realm = (await import(pathToFileURL(createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))}).resolve('realm')).href)).default;
const [file, dir, name, hold] = process.argv.slice(2);
const log = (m) => fs.appendFileSync(path.join(dir, name + '.log'), m + '\\n');
const r = new Realm({ path: file });
log('opened');
if (name === 'P') {
  while (!fs.existsSync(path.join(dir, 'go'))) await new Promise((res) => setTimeout(res, 10));
  r.beginTransaction();
  r.create('A', { id: 1000001, s: 'from P', d: 1 });
  log('in write transaction');
  await new Promise((res) => setTimeout(res, Number(hold)));
  r.commitTransaction();
  log('committed');
} else {
  const t = performance.now();
  r.write(() => r.create('A', { id: 1000002, s: 'from Q', d: 2 }));
  log('write took ' + Math.round(performance.now() - t));
}
r.close();
Realm.shutdown();
`);
  return f;
};
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lstatIno = (f) => { try { return fs.lstatSync(f).ino; } catch { return null; } };
const readLog = (d, name) => (fs.existsSync(path.join(d, name + '.log')) ? fs.readFileSync(path.join(d, name + '.log'), 'utf8') : '');

test('an app that opens the source during a run keeps its .lock, .note and .management: a second writer still waits for its write', async () => {
  const d = tmpDir('reg-appopen');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(2000));
  for (const s of ['.lock', '.note', '.management']) fs.rmSync(inp + s, { recursive: true, force: true });
  const script = appProcess(d);
  const exited = (p) => new Promise((res) => p.on('exit', (code) => res(code)));
  const procs = [];
  const start = (name, hold) => { const p = spawn(process.execPath, [script, inp, d, name, String(hold)], { stdio: 'ignore' }); procs.push(p); return [p, exited(p)]; };
  try {
    let pExit;
    let during;
    // The read-only open of the converter creates nothing next to the input; the
    // app opens it read-write while the conversion runs and creates the files.
    const r = await convert(inp, path.join(d, 'o.sqlite'), {
      _beforeVerify: () => {
        assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('app.realm.')), []);
        pExit = start('P', 1500)[1];
        const t = Date.now();
        while (!readLog(d, 'P').includes('opened')) { assert.ok(Date.now() - t < 20_000, 'the app did not open the file'); sleepSync(10); }
        during = Object.fromEntries(['.lock', '.note', '.management'].map((s) => [s, fs.lstatSync(inp + s).ino]));
      },
    });
    assert.equal(r.ok, true);
    // The run is over and the app still has the file open: its files are still there.
    for (const [s, ino] of Object.entries(during)) assert.equal(lstatIno(inp + s), ino, `${s} deleted or replaced by the run`);
    fs.writeFileSync(path.join(d, 'go'), '');
    const t = Date.now();
    while (!readLog(d, 'P').includes('in write transaction')) { assert.ok(Date.now() - t < 20_000); await new Promise((res) => setTimeout(res, 10)); }
    const qExit = start('Q', 0)[1];
    assert.deepEqual(await Promise.all([pExit, qExit]), [0, 0]);
    const took = Number(/write took (\d+)/.exec(readLog(d, 'Q'))[1]);
    assert.ok(took >= 500, `the second writer did not wait for the app's transaction (${took} ms)`);
    const check = await Realm.open({ path: inp, readOnly: true });
    try {
      assert.equal(check.objects('A').length, 2002);
      assert.ok(check.objectForPrimaryKey('A', 1000001) && check.objectForPrimaryKey('A', 1000002), 'a committed write was lost');
    } finally {
      check.close();
    }
  } finally {
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  }
});

test('outputs and report folders named like the SDK files of the input in another case are refused (they are the same file on most disks)', async () => {
  const d = tmpDir('reg-auxcase');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(20));
  for (const s of ['.lock', '.note', '.management']) fs.rmSync(inp + s, { recursive: true, force: true });
  const sha = await fileSha256(inp);
  for (const out of ['app.realm.Lock', 'APP.REALM.LOCK', 'app.realm.NOTE', 'App.realm.management', 'app.realm.fresh.LOCK']) {
    const r = cli([inp, path.join(d, out), '--force']);
    assert.equal(r.status, 1, out + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /a file the SDK uses next to the input/, out);
  }
  for (const rep of ['APP.realm.management', 'app.realm.MANAGEMENT/sub', 'App.Realm.Note']) {
    const r = cli([inp, path.join(d, 'o.sqlite'), '--report', path.join(d, rep)]);
    assert.equal(r.status, 1, rep + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /a file the SDK uses next to the input.*choose another report folder/, rep);
  }
  assert.deepEqual(fs.readdirSync(d), ['app.realm']);
  // Existing SDK files (the app opened the file) by name, case variant or link.
  const app = await Realm.open({ path: inp });
  app.close();
  fs.linkSync(inp + '.lock', path.join(d, 'hard.sqlite'));
  for (const out of ['app.realm.lock', 'APP.realm.LOCK', 'hard.sqlite']) {
    const r = cli([inp, path.join(d, out), '--force']);
    assert.equal(r.status, 1, out + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /a file the SDK uses next to the input/, out);
  }
  // Names that only start like them are outputs like any other.
  assert.equal(cli([inp, path.join(d, 'app.realm.lock.sqlite')]).status, 0);
  assert.equal(await fileSha256(inp), sha);
});

test('long output names: the temporary name is short; up to 247 bytes works, longer is refused with a clear message', async () => {
  const d = tmpDir('reg-longname');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(20));
  let seen;
  for (const n of [227, 240, 247]) {
    const out = path.join(d, 'x'.repeat(n - 7) + '.sqlite');
    const r = await convert(inp, out, { _beforeVerify: () => { seen = fs.readdirSync(d).filter((f) => f.endsWith('.partial')); } });
    assert.equal(r.ok, true, String(n));
    assert.equal(fs.existsSync(out), true, String(n));
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^afterdb\.[0-9a-f]{12}\.partial$/);
    fs.rmSync(out);
  }
  // <out>.failed (7 bytes more) still fits.
  const out247 = path.join(d, 'y'.repeat(240) + '.sqlite');
  assert.equal((await convert(inp, out247, { _beforeVerify: tamper })).ok, false);
  assert.equal(fs.existsSync(out247 + '.failed'), true);
  fs.rmSync(out247 + '.failed');
  for (const n of [248, 255, 300]) {
    const r = cli([inp, path.join(d, 'z'.repeat(n - 7) + '.sqlite')]);
    assert.equal(r.status, 1, String(n));
    assert.match(r.stderr, new RegExp(`output name too long for this disk: ${n} bytes; SQLite needs <name>-journal .* at most 247`), String(n));
  }
  assert.deepEqual(ls(d), ['app.realm']);
});

test('the database and the report are no more open than the input; --force keeps a narrower mode of the old output', async () => {
  const d = tmpDir('reg-modes');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(20));
  const mode = (f) => fs.statSync(f).mode & 0o777;
  const old = process.umask(0o022);
  try {
    fs.chmodSync(inp, 0o600);
    let partial;
    const rep = path.join(d, 'rep');
    const r = await convert(inp, path.join(d, 'o.sqlite'), { report: rep, _beforeVerify: () => { partial = fs.readdirSync(d).filter((f) => f.includes('.partial')).map((f) => [f, mode(path.join(d, f))]); } });
    assert.equal(r.ok, true);
    assert.ok(partial.length >= 1 && partial.every(([, m]) => m === 0o600), JSON.stringify(partial));
    assert.equal(mode(path.join(d, 'o.sqlite')), 0o600);
    assert.equal(mode(path.join(rep, 'report.json')), 0o600);
    assert.equal(mode(path.join(rep, 'report.md')), 0o600);
    // --force over a private output, from a 0644 input: stays private.
    fs.chmodSync(inp, 0o644);
    assert.equal((await convert(inp, path.join(d, 'o.sqlite'), { report: rep, force: true })).ok, true);
    assert.equal(mode(path.join(d, 'o.sqlite')), 0o600);
    assert.equal(mode(path.join(rep, 'report.json')), 0o600);
    // A new output: the input's bits, at most 0644 and always owner read/write, minus the umask.
    for (const [um, inMode, want] of [[0o022, 0o644, 0o644], [0o002, 0o664, 0o644], [0o000, 0o666, 0o644], [0o022, 0o640, 0o640], [0o077, 0o644, 0o600], [0o022, 0o444, 0o644]]) {
      process.umask(um);
      fs.chmodSync(inp, inMode);
      const out = path.join(d, `n${um}-${inMode}.sqlite`);
      assert.equal((await convert(inp, out)).ok, true);
      assert.equal(mode(out).toString(8), want.toString(8), `umask ${um.toString(8)}, input ${inMode.toString(8)}`);
    }
  } finally {
    process.umask(old);
    fs.chmodSync(inp, 0o644);
  }
});

test('-h as an option value is refused like an option, as USAGE and the README say', () => {
  const d = tmpDir('reg-dash-h');
  for (const opt of ['--report', '--schema', '--key']) {
    const r = cli([path.join(d, 'in.realm'), path.join(d, 'o.sqlite'), opt, '-h']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${opt} needs a value, got the option -h`));
  }
  assert.match(cli(['--help']).stdout, /An option value may not start with "--" or be "-h"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /An option value may not start with `--` or be `-h`/);
  assert.deepEqual(fs.readdirSync(d), []);
});

test('a {list} after ==, !=, <, BEGINSWITH... is Unsupported, never a null comparison; == ANY / SOME {...} is the element test on lists too', async () => {
  const schema = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int?', d: 'double?', s: 'string?', l: 'K?', ls: 'K[]', sl: 'string?[]', il: 'int?[]' } }];
  const ctx = await sdkSql('reg-listlit', schema, (r) => {
    const o = [];
    for (let k = 0; k < 10; k++) o.push(r.create('K', { id: k, i: k === 3 ? null : k % 4, d: k === 5 ? null : k / 2, s: [null, 'a', 'b', 'ab', 'ba', 'A', '', 'c', 'a', 'bb'][k], sl: [[], ['a', 'z'], ['z', 'a'], ['a'], ['a', 'z', 'a'], [null], ['b'], ['a', 'b'], ['z'], ['a', 'z']][k], il: [[], [1, 2], [2, 1], [1], [null], [1, 2, 3], [2], [0], [1, 2], [3]][k] }));
    o.forEach((x, k) => { x.l = k % 4 === 0 ? null : o[(k + 1) % 10]; x.ls = k % 3 === 0 ? [] : [o[(k + 2) % 10], o[(k + 5) % 10]]; });
  });
  try {
    // Measured on the SDK: 39 of these were answered with a comparison with null before.
    const lists = ['i == {1, 2}', 'i == {2}', 'i == {null}', 'i == {1, null}', 'i != {1, 2}', 'i != {1}', 'i > {1, 2}', 'i >= {2, 3}', 'i < {1}', 'i <= {0, 1}', 'NOT i == {1, 2}',
      'd == {1, 1.5}', 'd > {1, 3}', 's == {"a", "b"}', 's != {"a"}', 's BEGINSWITH {"a", "b"}', 's ENDSWITH {"a"}', 's CONTAINS {"b"}', 's LIKE {"a*"}', 's ==[c] {"A"}', 'i == {}', 'i != {}',
      'l.i == {1, 2}', 'l.s == {"a", "b"}', 'l.i > {1}', 'sl == {"a", "z"}', 'sl == {"z", "a"}', 'sl == {"a"}', 'sl != {"a", "z"}', 'il == {1, 2}', 'il == {1}', 'il > {1}',
      'ANY sl == {"a", "b"}', 'ALL il == {1, 2}', 'ls.i == {1, 2}', 'ANY ls.i == {1, 2}', 'il == {}', '{1, 2} == i', '{1, 2} != i', ['i == {$0, $1}', [1, 2]], '{1, 2} IN il',
      'i != ANY {1, 2}', 'i > ANY {1, 2}', 'i == ALL {1, 2}', 'i == NONE {1, 2}', 'i IN ANY {1}', 'i IN SOME {1}', ['i != ALL $0', [[1, 2]]], ['il IN $0', [[1, 2]]]];
    const answered = ['sl IN {"a", "z"}', 'il IN {1, 2}', 'i IN {1, 2}', 'i IN {}', 'i == ANY {}', 'i == ANY {1, 2}', 'i == SOME {1, 2}', 'il == ANY {1, 2}', 'il == ANY {1}', 'il == ANY {2, 1}',
      'sl == ANY {"a", "z"}', 'ls.i == ANY {1, 2}', 'il == SOME {1, 2}', 'ANY il == ANY {1, 2}', 'ALL il == ANY {1, 2}', 'NONE il == SOME {1}', 'ANY il IN {1, 2}',
      ['i == ANY $0', [[1, 2]]], ['il == ANY $0', [[1, 2]]], ['i == SOME $0', [[2]]], ['ANY il IN $0', [[1, 2]]], ['i IN $0', [[1, 2]]]];
    const n = agree(ctx, 'K', [...lists, ...answered], { unsupported: (q) => lists.some((x) => (Array.isArray(x) ? x[0] : x) === q) });
    assert.equal(n, lists.length + answered.length);
    // A trailing comma is a syntax error in the SDK.
    for (const q of ['i IN {1, 2,}', 'i == ANY {1,}', 'i IN {,}']) {
      assert.throws(() => ctx.realm.objects('K').filtered(q), q);
      assert.throws(() => translate(q, { model: ctx.model, className: 'K' }), (e) => e instanceof RqlError && !(e instanceof Unsupported), q);
    }
  } finally {
    ctx.close();
  }
});

test('integer literals are read as the SDK reads them: 010 is 8, 08 is 0, 0x10 is 16, LIMIT(010) is 8', async () => {
  const schema = [{ name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int?', d: 'double?', f: 'float?', s: 'string?', ls: 'K[]', il: 'int[]' } }];
  const V = [0, 1, 7, 8, 9, 10, 16, 64, -8, -10, 12, 511, 31, 4321];
  const ctx = await sdkSql('reg-octal', schema, (r) => {
    const o = V.map((v, k) => r.create('K', { id: k, i: v, d: v, f: v, s: 'x'.repeat(k), il: [v] }));
    o.forEach((x, k) => { x.ls = [o[k]]; });
  });
  try {
    const Q = ['i == 010', 'i == 0010', 'i == 08', 'i == 09', 'i == 019', 'i == 012', 'i == 0777', 'i == -010', 'i == +010', 'i > 010', 'i <= 010', 'i == 0x10', 'i == 0X1f', 'i == 0x10e1', 'i == 0xA',
      'i == 00', 'i == 0', 'i == -0', 'i == +1', 'i==-8', 'i==010', 'd == 010', 'd == 010.0', 'd == 010.5', 'd == 010e0', 'd == 010.', 'd == 08.5', 'd == +1e1', 'f == 010', 'd == 0x10',
      'i IN {010, 012}', 'i IN {0x10, 010}', 'i IN {+1, -010}', 'i == ANY {010}', 'ls.i == 010', 'ANY il == 010', 'ALL il == 010', 'ls.@count == 01', 'il.@count == 01', 's.@size == 010', 's.@size == 0xa',
      'i == 010 SORT(i ASC)', 'TRUEPREDICATE SORT(id ASC) LIMIT(010)', 'TRUEPREDICATE SORT(id ASC) LIMIT(08)', 'TRUEPREDICATE SORT(id ASC) LIMIT(03)', 'TRUEPREDICATE SORT(id ASC) LIMIT(00)',
      'TRUEPREDICATE SORT(id ASC) LIMIT(99999999999999999999)', 'i == 1 SORT(i ASC) LIMIT(01)',
      // syntax errors in the SDK too: no sign before 0x, no hex in LIMIT, LIMIT takes digits only
      'i == -0x10', 'i == +0x10', 'i == 0x', 'i == 0x1g', 'i == 00x10', 'd == 0x10.5', 'i == 1_0', 'i == 0b101', 'i == - 010',
      'TRUEPREDICATE LIMIT(0x3)', 'TRUEPREDICATE LIMIT(+3)', 'TRUEPREDICATE LIMIT(-1)', 'TRUEPREDICATE LIMIT(3.0)', 'TRUEPREDICATE LIMIT(1e1)'];
    assert.equal(agree(ctx, 'K', Q, { strict: true }), 48);
  } finally {
    ctx.close();
  }
});

test('two key paths, [c] and orderings: what the SDK refuses is RqlError, what it answers gives its rows or Unsupported', async () => {
  const { ObjectId, UUID, Decimal128 } = Realm.BSON;
  const schema = [
    { name: 'K', primaryKey: 'id', properties: { id: 'int', i: 'int?', j: 'int?', d: 'double?', b: 'bool?', c: 'bool?', s: 'string?', t: 'string?', dt: 'date?', et: 'date?', oid: 'objectId?', oid2: 'objectId?', u: 'uuid?', u2: 'uuid?', bin: 'data?', bin2: 'data?', l: 'K?', m: 'P?', ls: 'K[]', ml: 'P[]', il: 'int?[]', sl: 'string?[]', bl: 'bool?[]', bnl: 'data?[]', dec: 'decimal128?', dec2: 'decimal128?', e: 'E?' } },
    { name: 'P', primaryKey: 'id', properties: { id: 'int', i: 'int?' } },
    { name: 'E', embedded: true, properties: { n: 'int?', s: 'string?', ll: 'K?' } },
  ];
  const OIDS = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012', 'ffff1f77bcf86cd799439011', '000f1f77bcf86cd799439011'];
  const UIDS = ['9b2f4b5e-1c3a-4d6e-8f70-123456789abc', '0b2f4b5e-1c3a-4d6e-8f70-123456789abc', 'fb2f4b5e-1c3a-4d6e-8f70-123456789abc', '9b2f4b5e-1c3a-4d6e-8f70-123456789abd'];
  const ctx = await sdkSql('reg-pathtypes', schema, (r) => {
    // P objects created in reverse key order: their object keys are not their primary keys.
    const ps = [5, 4, 3, 2, 1, 0].map((k) => r.create('P', { id: k, i: k }));
    const o = [];
    for (let k = 0; k < 6; k++) {
      o.push(r.create('K', { id: k, i: k % 3 === 2 ? null : k % 3, j: (k + 1) % 3, d: k === 4 ? null : k / 2, b: k % 3 === 2 ? null : k % 2 === 0, c: k % 2 === 1, s: ['a', 'A', 'b', null, 'B', 'é'][k], t: ['A', 'a', 'c', 'x', null, 'É'][k],
        dt: k === 3 ? null : new Date(k), et: new Date(5 - k), oid: k === 1 ? null : new ObjectId(OIDS[k % 4]), oid2: new ObjectId(OIDS[(k + 1) % 4]), u: new UUID(UIDS[k % 4]), u2: new UUID(UIDS[(k + 2) % 4]),
        bin: k === 2 ? null : new Uint8Array([k, 1]).buffer, bin2: new Uint8Array([1, k]).buffer, il: [k % 3 === 2 ? null : k % 3], sl: [k === 0 ? null : 'a'], bl: [k % 2 === 0, null], bnl: [new Uint8Array([k]).buffer],
        dec: Decimal128.fromString(String(k * 5)), dec2: Decimal128.fromString('10'), e: k === 5 ? null : { n: k % 2 ? null : k, s: k % 2 ? 'x' : null } }));
    }
    o.forEach((x, k) => { x.l = k === 4 ? null : o[(k + 1) % 6]; x.m = ps.find((p) => p.id === k); x.ls = [o[(k + 1) % 6]]; x.ml = [ps[k]]; if (x.e) x.e.ll = o[k]; });
  });
  try {
    const P1 = ctx.realm.objectForPrimaryKey('K', 1);
    const OID = new ObjectId(OIDS[2]);
    const bytes = new Uint8Array([1, 1]).buffer;
    // Refused by the SDK: answered by the translator before.
    const refused = ['s == i', 'i == s', 's != i', 's < i', 'b == i', 'i == b', 'dt == i', 'dt < i', 'i < dt', 'dt == oid', 'l == i', 'i == l', 'l == s', 'id == m', 'oid == s', 's == oid', 'oid < s', 'oid != s', 'u == s',
      's == bin', 'i BEGINSWITH j', 'i CONTAINS j', 'dt ENDSWITH et', 's CONTAINS i', 'l < l', 'l < m', 'ls < l',
      's <[c] "b"', 's >[c] "b"', 's <=[c] "b"', 's >=[c] t', 's =<[c] "a"', 's =>[c] "a"', 'l.s >[c] "a"', 'ANY sl <[c] "b"',
      'i ==[c] j', 'b ==[c] c', 'dt ==[c] et', 'oid ==[c] oid2', 'l ==[c] l', 'i ==[c] s',
      'i ==[c] null', 'd ==[c] null', 'b ==[c] null', 'dt ==[c] null', 'oid ==[c] null', 'l.i ==[c] null', 'ANY il ==[c] null', 's.@size ==[c] null', 'i !=[c] null', ['i ==[c] $0', [null]],
      'l.i ==[c] 1', 'ANY il ==[c] 1', 'ANY ls.i !=[c] 1', 'e.n ==[c] 0', 'l.d ==[c] 0.5', 'l.b ==[c] true', 'ls.@count ==[c] 1', 's.@size !=[c] 1', 'l.l ==[c] null',
      ['l IN[c] {$0}', [P1]], 'l IN[c] {null}', ['l.l ==[c] $0', [P1]], 'bin == "ab"', 'bin > "ab"'];
    // Answered by the SDK, not translated.
    const unsupported = ['l == m', 'm == l', 'l != m', 'ANY ls == m', 'ANY ml == l', 'oid BEGINSWITH s', 'u CONTAINS s', 'bin == bin2', 'bin < bin2', 'bin BEGINSWITH bin2', 's BEGINSWITH bin', 'bin CONTAINS s',
      'dec < dec2', 'i == dec', 'i < d', 'bin ==[c] bin2', ['bin == $0', [bytes]], ['bin != $0', [bytes]], ['bin BEGINSWITH $0', [bytes]], ['l.bin2 == $0', [bytes]], ['ANY bnl == $0', [bytes]], ['bin IN $0', [[bytes]]],
      ['bin ==[c] $0', [bytes]], 'bin BEGINSWITH "ab"', 'bin CONTAINS "b"', 'bin LIKE "a*"', 'bin IN {"ab"}'];
    // Answered by the SDK and translated ([c] ignored on a value that is not a string; bool, objectId, uuid orderings).
    const same = ['i ==[c] 1', 'i !=[c] 1', 'i =[c] 1', 'i <>[c] 1', 'd ==[c] 0.5', 'b ==[c] true', ['dt ==[c] $0', [new Date(1)]], ['oid ==[c] $0', [OID]], ['u ==[c] $0', [new UUID(UIDS[1])]], ['l ==[c] $0', [P1]], ['ANY ls ==[c] $0', [P1]], 'l ==[c] null', ['l !=[c] $0', [null]], 'e ==[c] null', 'bin ==[c] null',
      'i IN[c] {1, 2}', 'i IN[c] {null}', 'l.i IN[c] {1}', 'ANY il IN[c] {1}', 'ANY ls.i IN[c] {1}', 'e.n IN[c] {0}', 'l.d IN[c] {0.5}', 'l.b IN[c] {true}', ['l.dt IN[c] {$0}', [new Date(1)]], 'ls.@count IN[c] {1}', 's.@size IN[c] {1}', 'il.@count IN[c] {null}',
      's ==[c] t', 's !=[c] t', 's BEGINSWITH[c] t', 's CONTAINS[c] t', 's ENDSWITH[c] t', 'l.s ==[c] t', 's <>[c] "a"', 's =[c] "a"', 's ==[c] null',
      'b < true', 'b > false', ['b <= $0', [true]], 'b >= false', 'b < c', 'b > c', 'b < null', 'b <= null', 'l.b < true', 'l.b >= false', 'ANY bl < true', 'ALL bl <= true', 'bl > false', ['l.b > $0', [false]], 'NOT b < true',
      'oid < oid2', 'oid > oid2', ['oid <= $0', [OID]], 'u < u2', 'u >= u2', ['u > $0', [new UUID(UIDS[0])]], 'oid == oid2', 'dt < et', 'dt <= et', 'l.m == m', 'm == m', 'l == l', 'l == l.l', 'ls == l', 'i == j', 'i < j', 'ls.@count == i', 's.@size == i'];
    const unsup = new Set(unsupported.map((x) => (Array.isArray(x) ? x[0] : x)));
    const n = agree(ctx, 'K', [...refused, ...unsupported, ...same], { strict: true, unsupported: (q) => unsup.has(q) });
    assert.equal(n, unsupported.length + same.length);
  } finally {
    ctx.close();
  }
});

test('a null embedded object inside a list drops the element, as a null link does; SORT puts a null nested embedded object after the values', async () => {
  const schema = [
    { name: 'Sub', embedded: true, properties: { n: 'int?', s: 'string?' } },
    { name: 'Addr', embedded: true, properties: { s: 'string?', sub: 'Sub?', n: 'int?' } },
    { name: 'P', primaryKey: 'id', properties: { id: 'int', home: 'Addr?', friends: 'P[]', boss: 'P?' } },
  ];
  const homes = [null, { s: 'a', sub: null, n: 4 }, { s: 'b', sub: { n: null }, n: null }, { s: 'c', sub: { n: 1, s: 'x' }, n: 5 }, { s: null, sub: { n: 0, s: null }, n: 1 }, { s: 'd', sub: { n: 2 }, n: 3 }, null, { s: 'e', sub: null, n: 6 }];
  const ctx = await sdkSql('reg-emblist', schema, (r) => {
    const ps = homes.map((h, k) => r.create('P', { id: k, home: h }));
    ps.forEach((p, k) => { p.friends = k === 2 ? [ps[0], ps[6]] : [ps[(k + 1) % 8], ps[(k + 3) % 8]]; p.boss = k % 3 ? ps[(k + 2) % 8] : null; });
  });
  try {
    const Q = ['TRUEPREDICATE SORT(home.sub.n ASC)', 'TRUEPREDICATE SORT(home.sub.n DESC)', 'TRUEPREDICATE SORT(home.s ASC)', 'TRUEPREDICATE SORT(home.s DESC)', 'TRUEPREDICATE SORT(boss.home.sub.n ASC)',
      'TRUEPREDICATE SORT(home.sub.s ASC, id DESC)', 'home.sub.n == null', 'home.sub.n != null', 'home.sub == null', 'home.sub.n > 0', 'boss.home.sub.n == null',
      'friends.home.n > 2', 'ALL friends.home.n > 2', 'NONE friends.home.n > 2', 'friends.home.n == null', 'ALL friends.home.n == null', 'friends.home.sub.n == null', 'ALL friends.home.sub.n > 0',
      'NONE friends.home.sub.n == 1', 'ANY friends.home.s == null', 'ALL friends.home.s != null', 'friends.home.s.@size == 1', 'ALL friends.home.sub.n >= 0', 'friends.boss.home.sub.n == 2',
      'friends.home == null', 'friends.home.sub == null', 'ANY friends.home != null', 'friends.home.sub.n.@count == 1'];
    assert.equal(agree(ctx, 'P', Q, { strict: true }), 24);
  } finally {
    ctx.close();
  }
});

// ---------- private copy: source changed after the copy, interrupt during the copy ----------

test('source changed, truncated or deleted after the copy: exit 0, the CLI and the report say "source unchanged: false"', async () => {
  const d = tmpDir('reg-snapshot');
  const inp = path.join(d, 'app.realm');
  await make(inp, SCHEMA, fill(50));
  const orig = fs.readFileSync(inp);
  const sha = await fileSha256(inp);
  // API: changes made by the _afterSnapshot hook, after the copy and its checks.
  // A smaller realm file, as the app's compact() leaves it (a new file).
  const small = path.join(d, 'small.realm');
  fs.writeFileSync(small, orig);
  const rs = await Realm.open({ path: small, schema: SCHEMA });
  assert.equal(rs.compact(), true);
  rs.close();
  const smallBytes = fs.readFileSync(small);
  fs.rmSync(small);
  assert.ok(smallBytes.length < orig.length);
  const cases = [
    ['changed', async () => { const r = await Realm.open({ path: inp, schema: SCHEMA }); r.write(() => r.create('A', { id: 999, s: 'new', d: 1 })); r.close(); }],
    ['truncated', () => fs.truncateSync(inp, 4096)],
    ['deleted', () => fs.rmSync(inp)],
    // Smaller but not cut short: replaced by another file, or the same file
    // rewritten with other bytes. Both are "changed", not "truncated".
    ['changed', () => { fs.writeFileSync(small, smallBytes); fs.renameSync(small, inp); }, 'replaced by a smaller file'],
    ['changed', () => { const fd = fs.openSync(inp, 'r+'); fs.ftruncateSync(fd, 4096); fs.writeSync(fd, Buffer.alloc(16, 0x5a), 0, 16, 100); fs.closeSync(fd); }, 'same file, smaller, other bytes'],
    ['unreadable', () => fs.chmodSync(inp, 0)],
  ];
  if (process.getuid?.() === 0) cases.pop(); // root reads a 000 file
  for (const [state, change, label = state] of cases) {
    if (fs.existsSync(inp)) fs.chmodSync(inp, 0o644);
    fs.writeFileSync(inp, orig);
    const name = label.replace(/\W+/g, '-');
    const out = path.join(d, `${name}.sqlite`);
    const rep = path.join(d, `rep-${name}`);
    const r = await convert(inp, out, { report: rep, _afterSnapshot: async () => change() });
    if (state === 'unreadable') fs.chmodSync(inp, 0o644);
    assert.equal(r.ok, true, label);
    assert.equal(r.input.unchanged, false, label);
    assert.equal(r.input.snapshot, true, label);
    assert.equal(r.input.atEnd, state, label);
    assert.equal(r.input.sha256Before, sha);
    assert.equal(r.input.sha256After === sha, false, label);
    if (state === 'truncated') assert.equal(r.input.bytesAfter, 4096);
    if (label === 'replaced by a smaller file') assert.equal(r.input.bytesAfter, smallBytes.length);
    if (state === 'deleted' || state === 'unreadable') assert.equal(r.input.sha256After, null);
    assert.match(r.input.copiedAt, /^\d{4}-\d\d-\d\dT/);
    // The output is the data of the copy: 50 rows, not the 51st written after it.
    assert.equal(sqlAll(out, 'SELECT count(*) AS n FROM "A"')[0].n, 50);
    const w = r.warnings.find((x) => x.startsWith('Source unchanged: false'));
    assert.ok(w, `${label}: ${r.warnings.join(' | ')}`);
    assert.ok(w.includes(`verified snapshot of the copy taken at ${r.input.copiedAt}`), w);
    assert.match(w, { changed: /wrote to it or replaced it/, truncated: /truncated after it was copied \(4096 bytes now, \d+ copied\)/, deleted: /deleted or moved/, unreadable: /could not be read at the end of the run/ }[state]);
    const md = fs.readFileSync(path.join(rep, 'report.md'), 'utf8');
    assert.ok(md.includes(`**NO** (${state})`) && md.includes(`snapshot of the copy taken at ${r.input.copiedAt}`), md);
    assert.equal(JSON.parse(fs.readFileSync(path.join(rep, 'report.json'), 'utf8')).input.atEnd, state);
    assert.deepEqual(temps(d), []);
  }
  // Changed during the copy (before the hashes that check it): exit 1, nothing written.
  fs.writeFileSync(inp, orig);
  await assert.rejects(convert(inp, path.join(d, 'during.sqlite'), { _afterCopy: () => fs.appendFileSync(inp, 'x') }), /the file changed while it was copied/);
  assert.equal(fs.existsSync(path.join(d, 'during.sqlite')), false);
  assert.deepEqual(temps(d), []);
  // Unchanged: the report says so.
  fs.writeFileSync(inp, orig);
  const r = await convert(inp, path.join(d, 'same.sqlite'));
  assert.equal(r.input.unchanged, true);
  assert.equal(r.input.atEnd, 'unchanged');
  assert.equal(r.input.snapshot, false);
  assert.ok(!r.warnings.some((x) => x.startsWith('Source unchanged')));

  // CLI: a hook appends to the source once the SQLite file is being written
  // (after the copy). Exit 0, the summary line and a warning say it.
  const hook = path.join(d, 'change-hook.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';
import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})('better-sqlite3');
const orig = Database.prototype.prepare;
let done = false;
Database.prototype.prepare = function (sql) {
  if (!done && sql.startsWith('INSERT INTO "_afterdb_meta"')) { done = true; fs.appendFileSync(${JSON.stringify(inp)}, 'x'); }
  return orig.call(this, sql);
};
`);
  const c = cli([inp, path.join(d, 'cli.sqlite'), '--report', path.join(d, 'rep-cli')], ['--import', pathToFileURL(hook).href]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^OK: .*source unchanged: false \(another program wrote to it or replaced it after it was copied; the output is a verified snapshot of the copy taken at \d{4}-[^)]+\)/m);
  assert.match(c.stdout, /^warning: Source unchanged: false/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'rep-cli', 'report.json'), 'utf8')).input.unchanged, false);
  assert.deepEqual(temps(d), []);
});

test('Ctrl-C, SIGTERM or SIGHUP during the copy of a large input: handled at once, the copy folder is deleted', { timeout: 120_000 }, async () => {
  const d = tmpDir('reg-sigcopy');
  const inp = path.join(d, 'big.realm');
  // 512 MiB, sparse (created at once): the copy writes it in full (about 1 s
  // on APFS), the hash before it reads it. Not a realm file: the run is
  // interrupted before the SDK opens anything.
  const size = 512 * 1048576;
  const fd = fs.openSync(inp, 'w');
  fs.ftruncateSync(fd, size);
  fs.writeSync(fd, Buffer.from('end'), 0, 3, size - 3);
  fs.closeSync(fd);
  const out = path.join(d, 'o.sqlite');
  const copyFile = () => {
    const c = fs.readdirSync(d).find((f) => /^afterdb\.[0-9a-f]{12}\.copy$/.test(f));
    return c && path.join(d, c, 'source.realm');
  };
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  try {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const p = spawn(process.execPath, [BIN, inp, out, '--report', path.join(d, 'rep')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      p.stdout.on('data', (b) => { output += b; });
      p.stderr.on('data', (b) => { output += b; });
      const exited = new Promise((res) => p.on('exit', (code, signal) => res({ code, signal, at: performance.now() })));
      // Wait until the copy has started (its file exists and is being written).
      let f;
      let copied = 0;
      const t0 = performance.now();
      while (!(f = copyFile()) || !(copied = sizeOf(f))) {
        assert.ok(performance.now() - t0 < 30_000, `the copy did not start: ${output}`);
        await new Promise((r) => setTimeout(r, 2));
      }
      const sent = performance.now();
      p.kill(sig);
      const { code, signal, at } = await exited;
      const latency = at - sent;
      assert.ok(copied < size, `${sig}: the copy was already complete (${copied} bytes)`);
      assert.equal(signal, sig, `${sig}: exit ${code}: ${output}`);
      assert.match(output, new RegExp(`interrupted \\(${sig}\\)`));
      // A blocking copy would delay the handler until the end of the copy (about 1 s here).
      assert.ok(latency < 500, `${sig} handled after ${Math.round(latency)} ms`);
      assert.deepEqual(fs.readdirSync(d).sort(), ['big.realm'], `${sig}: ${output}`);
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
