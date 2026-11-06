// Regression tests for the adversarial review of the converter. Each test uses
// the same inputs as the review's reproduction script.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Realm from 'realm';
import Database from 'better-sqlite3';
import { convert, fileSha256 } from '../src/convert.mjs';
import { mergeAppSchema, normalizeAppSchema } from '../src/schema.mjs';
import { translate } from '../src/rql.mjs';
import { tmpPath, makeAllTypes, schema as allTypesSchema } from './fixtures.mjs';

after(() => Realm.shutdown());

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin/keel-convert.mjs');
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
const meta = (file, key) => {
  const db = new Database(file, { readonly: true });
  try { return JSON.parse(db.prepare('SELECT "value" FROM "_keel_meta" WHERE "key" = ?').pluck().get(key)); } finally { db.close(); }
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

test('an input named <out>.partial or <out>.failed is refused and left in place', async () => {
  const d = tmpDir('reg-collide');
  const gen = path.join(d, 'gen.realm');
  await make(gen, SCHEMA, fill(50));
  const sha = await fileSha256(gen);

  const inA = path.join(d, 'export.partial');
  fs.copyFileSync(gen, inA);
  const r = cli([inA, path.join(d, 'export')]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /export\.partial is the input file/);
  assert.equal(await fileSha256(inA), sha);
  assert.equal(await realmCount(inA, 'A'), 50);

  const inB = path.join(d, 'x.failed');
  fs.copyFileSync(gen, inB);
  await assert.rejects(convert(inB, path.join(d, 'x'), { _beforeVerify: tamper }), /x\.failed is the input file/);
  assert.equal(await fileSha256(inB), sha);
  assert.deepEqual(ls(d).filter((f) => f.startsWith('export') || f.startsWith('x')), ['export.partial', 'x.failed']);
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
  if (!done && sql.startsWith('INSERT INTO "_keel_meta"')) { done = true; this.exec('DELETE FROM "A" WHERE id = 1'); }
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

  // The report fails only when written (report.json is a folder): same result.
  const rep2 = path.join(d, 'rep2');
  fs.mkdirSync(path.join(rep2, 'report.json'), { recursive: true });
  await assert.rejects(convert(inp, out, { force: true, report: rep2 }));
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD');
  assert.equal(fs.existsSync(out + '.partial'), false);
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
  assert.equal(fs.existsSync(out + '.partial'), false);
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

test('an output path that is a folder is refused before the conversion; a failed rename deletes .partial', async () => {
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

  // A folder that appears at <out> during the run: the rename fails, .partial is deleted.
  const out = path.join(d, 'late.sqlite');
  await assert.rejects(convert(inp, out, { _beforeVerify: () => fs.mkdirSync(out) }));
  assert.equal(fs.existsSync(out + '.partial'), false);
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

test('index renames are recorded in _keel_meta, the model and the warnings', async () => {
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
