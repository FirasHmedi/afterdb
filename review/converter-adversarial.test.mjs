// Adversarial tests of the converter (keel-convert). Uses the converter's own realm@20.2.0 and better-sqlite3.
// Run after `cd converter && npm install`: node --test --test-concurrency=1 review/converter-adversarial.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const conv = path.join(root, 'converter');
const req = createRequire(path.join(conv, 'package.json'));
const Realm = (await import(pathToFileURL(req.resolve('realm')).href)).default;
const Database = req('better-sqlite3');
const { convert } = await import(pathToFileURL(path.join(conv, 'src/convert.mjs')).href);
const TMP = fs.mkdtempSync(path.join(tmpdir(), 'review-conv-'));
const p = (n) => path.join(TMP, n);
after(() => Realm.shutdown());

async function make(file, schema, fill, extra = {}) {
  const r = await Realm.open({ path: file, schema, ...extra });
  if (fill) r.write(() => fill(r));
  r.close();
}
const cli = (...args) => spawnSync('node', [path.join(conv, 'bin/keel-convert.mjs'), ...args], { encoding: 'utf8', timeout: 120_000 });

test('empty realm (one class, 0 objects) and realm with only an embedded class + 0-object class', async () => {
  await make(p('empty.realm'), [{ name: 'A', properties: { x: 'int' } }]);
  const r = await convert(p('empty.realm'), p('empty.sqlite'));
  assert.equal(r.ok, true);
  await make(p('emb.realm'), [{ name: 'E', embedded: true, properties: { s: 'string' } }, { name: 'H', properties: { e: 'E?' } }]);
  const r2 = await convert(p('emb.realm'), p('emb.sqlite'));
  assert.equal(r2.ok, true);
});

test('deep embedded nesting, cycles of links, dictionary/set of links, mixed with nested collections and a link', async () => {
  const schema = [
    { name: 'L3', embedded: true, properties: { v: 'string', d: 'double?' } },
    { name: 'L2', embedded: true, properties: { l3: 'L3[]', m: 'mixed' } },
    { name: 'L1', embedded: true, properties: { l2: 'L2?' } },
    { name: 'N', primaryKey: '_id', properties: { _id: 'objectId', next: 'N?', l1: 'L1?', ds: 'N{}', ss: 'N<>', m: 'mixed', back: { type: 'linkingObjects', objectType: 'N', property: 'next' } } },
  ];
  const { ObjectId } = Realm.BSON;
  await make(p('deep.realm'), schema, (r) => {
    const ns = [];
    for (let i = 0; i < 50; i++) ns.push(r.create('N', { _id: new ObjectId(), l1: { l2: { l3: [{ v: 'é'.repeat(i), d: i % 2 ? NaN : -0 }], m: { a: [1, { b: new Date(-5) }] } } } }));
    ns.forEach((n, i) => { n.next = ns[(i + 1) % ns.length]; n.ds = { k: ns[(i + 7) % 50], 'a b é': ns[i] }; n.ss = [ns[i], ns[(i + 3) % 50]]; n.m = i % 2 ? ns[(i + 2) % 50] : [ns[0], 'x', { y: ns[1] }]; });
  });
  const r = await convert(p('deep.realm'), p('deep.sqlite'), { schema });
  assert.equal(r.ok, true, JSON.stringify(r.verification.mismatches.slice(0, 3)));
  assert.equal(r.verification.views[0].rows, 50);
});

test('unicode: lone surrogates, NUL, NFC vs NFD distinct primary keys, 4-byte emoji, RTL; 15 MB string', async () => {
  const schema = [{ name: 'S', primaryKey: 'k', properties: { k: 'string', v: 'string', big: 'string?' } }];
  await make(p('uni.realm'), schema, (r) => {
    r.create('S', { k: 'é', v: 'NFC' });
    r.create('S', { k: 'é', v: 'NFD' });
    r.create('S', { k: 'E', v: 'upper' });
    r.create('S', { k: 'e', v: 'lower' });
    r.create('S', { k: 'a\u0000b', v: 'nul in pk' });
    r.create('S', { k: '\ud83d', v: 'lone surrogate \udc00' });
    r.create('S', { k: 'rtl', v: '‮abc שלום', big: 'x'.repeat(15 * 1024 * 1024) });
  });
  const r = await convert(p('uni.realm'), p('uni.sqlite'));
  assert.equal(r.ok, true, JSON.stringify(r.verification.mismatches.slice(0, 3)));
  const db = new Database(p('uni.sqlite'), { readonly: true });
  assert.equal(db.prepare('SELECT count(*) FROM S').pluck().get(), 7);
  db.close();
});

// Name conflicts (SQLite identifiers ignore case, generated names, reserved names): converted with a fixed
// suffix, a warning and a `renames` entry in _keel_meta. Updated on 2026-11-06 after the converter fix.
function tableRows(file, table) {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}"`).all();
  } finally {
    db.close();
  }
}

test('SQLite identifiers are case-insensitive: classes "Item" and "item" both converted, "item" renamed', async () => {
  await make(p('case.realm'), [{ name: 'Item', properties: { a: 'int' } }, { name: 'item', properties: { b: 'int' } }], (r) => { r.create('Item', { a: 1 }); r.create('item', { b: 2 }); });
  const r = await convert(p('case.realm'), p('case.sqlite'));
  assert.equal(r.ok, true);
  assert.deepEqual(tableRows(p('case.sqlite'), 'Item').map((x) => x.a), [1]);
  assert.deepEqual(tableRows(p('case.sqlite'), 'item_2').map((x) => x.b), [2]);
  assert.ok(r.warnings.some((w) => w.includes('item_2')), r.warnings.join('\n'));
});

test('properties "name" and "Name" in the same class: both kept, "Name" renamed', async () => {
  await make(p('case2.realm'), [{ name: 'P', properties: { name: 'string', Name: 'string' } }], (r) => r.create('P', { name: 'a', Name: 'b' }));
  const r = await convert(p('case2.realm'), p('case2.sqlite'));
  assert.equal(r.ok, true);
  const [row] = tableRows(p('case2.sqlite'), 'P');
  assert.equal(row.name, 'a');
  assert.equal(row.Name_2, 'b');
});

test('generated names collide: class "A__b" next to class A with a list "b": both kept', async () => {
  await make(p('clash.realm'), [{ name: 'A', properties: { b: 'int[]' } }, { name: 'A__b', properties: { z: 'int' } }], (r) => { r.create('A', { b: [1] }); r.create('A__b', { z: 9 }); });
  const r = await convert(p('clash.realm'), p('clash.sqlite'));
  assert.equal(r.ok, true);
  assert.deepEqual(tableRows(p('clash.sqlite'), 'A__b').map((x) => x.z), [9]);
  assert.equal(tableRows(p('clash.sqlite'), 'A__b_2').length, 1);
});

test('a class named _keel_meta is converted under another name; the tool metadata is intact', async () => {
  await make(p('meta.realm'), [{ name: '_keel_meta', properties: { key: 'string', value: 'string' } }], (r) => r.create('_keel_meta', { key: 'a', value: 'b' }));
  const r = await convert(p('meta.realm'), p('meta.sqlite'));
  assert.equal(r.ok, true);
  assert.deepEqual(tableRows(p('meta.sqlite'), '_keel_meta_2').map((x) => [x.key, x.value]), [['a', 'b']]);
  assert.ok(tableRows(p('meta.sqlite'), '_keel_meta').some((x) => x.key === 'renames'));
});

test('--schema with only a subset of the classes: are the other classes silently dropped while verification says OK?', async () => {
  const full = [{ name: 'Keep', properties: { a: 'int' } }, { name: 'Lost', properties: { b: 'string' } }];
  await make(p('subset.realm'), full, (r) => { r.create('Keep', { a: 1 }); for (let i = 0; i < 10; i++) r.create('Lost', { b: 'data ' + i }); });
  let r;
  try {
    r = await convert(p('subset.realm'), p('subset.sqlite'), { schema: [full[0]] });
  } catch (e) {
    console.log('refused:', e.message);
    return; // refusing is acceptable
  }
  const db = new Database(p('subset.sqlite'), { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();
  db.close();
  console.log('ok =', r.ok, 'tables =', tables.join(','), 'warnings =', JSON.stringify(r.warnings));
  assert.ok(!(r.ok && !tables.includes('Lost')), 'SILENT DATA LOSS: class "Lost" (10 objects) missing from the output, yet verification ok = true');
});

test('--schema with a property subset: is the missing property silently dropped?', async () => {
  const full = [{ name: 'T', properties: { a: 'int', secret: 'string' } }];
  await make(p('psubset.realm'), full, (r) => r.create('T', { a: 1, secret: 'keep me' }));
  let r;
  try {
    r = await convert(p('psubset.realm'), p('psubset.sqlite'), { schema: [{ name: 'T', properties: { a: 'int' } }] });
  } catch (e) {
    console.log('refused:', e.message);
    return;
  }
  const db = new Database(p('psubset.sqlite'), { readonly: true });
  const cols = db.prepare('PRAGMA table_info("T")').all().map((c) => c.name);
  db.close();
  console.log('ok =', r.ok, 'columns =', cols.join(','));
  assert.ok(!(r.ok && !cols.includes('secret')), 'SILENT DATA LOSS: column "secret" missing, yet verification ok = true');
});

test('wrong key, no key on an encrypted file, corrupted and truncated files: exit code 1 and no output file', async () => {
  const key = Buffer.alloc(64, 7);
  await make(p('enc.realm'), [{ name: 'A', properties: { x: 'int' } }], (r) => r.create('A', { x: 1 }), { encryptionKey: key });
  const wrong = 'ff'.repeat(64);
  for (const [label, args] of [['wrong key', ['--key', wrong]], ['no key', []]]) {
    const r = cli(p('enc.realm'), p(`enc-${label}.sqlite`), ...args);
    assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(p(`enc-${label}.sqlite`)), false);
    assert.equal(fs.existsSync(p(`enc-${label}.sqlite.partial`)), false);
  }
  await make(p('ok.realm'), [{ name: 'A', properties: { x: 'int' } }], (r) => { for (let i = 0; i < 1000; i++) r.create('A', { x: i }); });
  const buf = fs.readFileSync(p('ok.realm'));
  const bad = Buffer.from(buf); for (let i = 4096; i < 8192; i++) bad[i] ^= 0x5a;
  fs.writeFileSync(p('corrupt.realm'), bad);
  fs.writeFileSync(p('trunc.realm'), buf.subarray(0, 100));
  fs.writeFileSync(p('garbage.realm'), Buffer.from('hello world, not a realm file at all'.repeat(200)));
  for (const f of ['corrupt', 'trunc', 'garbage']) {
    const before = fs.readFileSync(p(`${f}.realm`));
    const r = cli(p(`${f}.realm`), p(`${f}.sqlite`));
    console.log(`${f}: exit ${r.status} ${(r.stdout + r.stderr).trim().split('\n')[0].slice(0, 160)}`);
    assert.notEqual(r.status, 0, `${f} was accepted`);
    assert.equal(fs.existsSync(p(`${f}.sqlite`)), false);
    assert.ok(before.equals(fs.readFileSync(p(`${f}.realm`))), `${f}: source file modified`);
  }
});

test('--key on the command line is visible in the process list (ps): documented alternative KEEL_KEY works', async () => {
  const r = spawnSync('node', [path.join(conv, 'bin/keel-convert.mjs'), p('enc.realm'), p('enc-env.sqlite')], { encoding: 'utf8', env: { ...process.env, KEEL_KEY: '07'.repeat(64) } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('failed verification: <out> is not written, the file is kept as <out>.failed (exit 2)', async () => {
  await make(p('fail.realm'), [{ name: 'A', properties: { x: 'int' } }], (r) => { for (let i = 0; i < 5; i++) r.create('A', { x: i }); });
  // test hook of convert(): alter the SQLite file before verification
  const r = await convert(p('fail.realm'), p('fail.sqlite'), { _beforeVerify: (db) => db.exec('UPDATE "A" SET "x" = "x" + 1') });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(p('fail.sqlite')), false, 'failed output at the final path');
  assert.equal(fs.existsSync(p('fail.sqlite.failed')), true);
  assert.equal(fs.existsSync(p('fail.sqlite.partial')), false);
});

test('realistic: the app removed a class from its schema (Realm keeps the table and its rows); converting with the app schema drops it silently', async () => {
  const v1 = [{ name: 'Keep', properties: { a: 'int' } }, { name: 'Old', properties: { b: 'string' } }];
  await make(p('drift.realm'), v1, (r) => { r.create('Keep', { a: 1 }); r.create('Old', { b: 'still here' }); });
  await make(p('drift.realm'), [v1[0]], null, { schemaVersion: 2 });
  const noSchema = await convert(p('drift.realm'), p('drift-file.sqlite'));
  const withSchema = await convert(p('drift.realm'), p('drift-app.sqlite'), { schema: [v1[0]] });
  const has = (f) => new Database(p(f), { readonly: true }).prepare("SELECT count(*) FROM sqlite_master WHERE name='Old'").pluck().get();
  console.log(`file schema: ok=${noSchema.ok} Old table=${has('drift-file.sqlite')}; app schema: ok=${withSchema.ok} Old table=${has('drift-app.sqlite')}`);
  assert.equal(has('drift-file.sqlite'), 1, 'the file still holds class Old');
  assert.ok(!(withSchema.ok && !has('drift-app.sqlite')), 'SILENT DATA LOSS with --schema');
});
