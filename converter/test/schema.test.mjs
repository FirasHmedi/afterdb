// The file's own schema drives the conversion; --schema only adds backlinks.
// Also: output file handling (--force, failed verification) and name conflicts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Realm from 'realm';
import Database from 'better-sqlite3';
import { convert, fileSha256 } from '../src/convert.mjs';
import { translate } from '../src/rql.mjs';
import { tmpPath } from './fixtures.mjs';

after(() => Realm.shutdown());

async function make(file, schema, fill, extra = {}) {
  const r = await Realm.open({ path: file, schema, ...extra });
  if (fill) r.write(() => fill(r));
  r.close();
}
const open = (f) => new Database(f, { readonly: true });

test('class removed from the app schema is still converted, with a drift warning', async () => {
  const v1 = [{ name: 'Keep', properties: { a: 'int' } }, { name: 'Old', properties: { b: 'string' } }];
  const src = tmpPath('drift.realm');
  await make(src, v1, (r) => { r.create('Keep', { a: 1 }); for (let i = 0; i < 10; i++) r.create('Old', { b: 'old ' + i }); });
  await make(src, [v1[0]], null, { schemaVersion: 2 }); // the app dropped Old; the file keeps it
  const app = [v1[0], { name: 'New', properties: { c: 'int' } }];
  const r = await convert(src, tmpPath('drift.sqlite'), { schema: app });
  assert.equal(r.ok, true);
  const db = open(path.join(path.dirname(src), 'drift.sqlite'));
  assert.equal(db.prepare('SELECT count(*) FROM "Old"').pluck().get(), 10);
  assert.equal(db.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'New'").pluck().get(), 0);
  db.close();
  assert.ok(r.warnings.some((w) => /Schema drift: class Old is in the file but not in the app schema/.test(w)), r.warnings.join('\n'));
  assert.ok(r.warnings.some((w) => /Schema drift: class New is in the app schema but not in the file/.test(w)));
  assert.equal(r.verification.schemaCheck.ok, true);
});

test('property removed from the app schema is still converted, with a drift warning', async () => {
  const src = tmpPath('psubset.realm');
  await make(src, [{ name: 'T', properties: { a: 'int', secret: 'string' } }], (r) => r.create('T', { a: 1, secret: 'keep me' }));
  const r = await convert(src, tmpPath('psubset.sqlite'), { schema: [{ name: 'T', properties: { a: 'int', extra: 'string?' } }] });
  assert.equal(r.ok, true);
  const db = open(path.join(path.dirname(src), 'psubset.sqlite'));
  assert.equal(db.prepare('SELECT "secret" FROM "T"').pluck().get(), 'keep me');
  assert.equal(db.prepare('PRAGMA table_info("T")').all().some((c) => c.name === 'extra'), false);
  db.close();
  assert.ok(r.warnings.some((w) => /property T\.secret is in the file but not in the app schema/.test(w)), r.warnings.join('\n'));
  assert.ok(r.warnings.some((w) => /property T\.extra is in the app schema but not in the file/.test(w)));
});

test('backlinks from --schema are created (origin with mapTo), nothing else is taken from it', async () => {
  const app = [
    { name: 'A', primaryKey: '_id', properties: { _id: 'int', b: { type: 'object', objectType: 'B', mapTo: 'bee', optional: true }, bs: 'B[]' } },
    { name: 'B', properties: { x: 'int', one: { type: 'linkingObjects', objectType: 'A', property: 'bee' }, many: { type: 'linkingObjects', objectType: 'A', property: 'bs' } } },
  ];
  const src = tmpPath('bl.realm');
  await make(src, app, (r) => {
    const b1 = r.create('B', { x: 1 });
    const b2 = r.create('B', { x: 2 });
    r.create('A', { _id: 1, b: b1, bs: [b1, b2, b1] });
    r.create('A', { _id: 2, b: b1, bs: [b2] });
  });
  const r = await convert(src, tmpPath('bl.sqlite'), { schema: app });
  assert.equal(r.ok, true, JSON.stringify(r.verification.mismatches));
  assert.deepEqual(r.verification.views.map((v) => [v.view, v.rows, v.ok]), [['B__one', 2, true], ['B__many', 4, true]]);
  const db = open(path.join(path.dirname(src), 'bl.sqlite'));
  assert.equal(db.prepare('SELECT count(*) FROM "A" WHERE "bee" IS NOT NULL').pluck().get(), 2); // stored name, from the file
  db.close();
  assert.equal(r.warnings.filter((w) => w.startsWith('Schema drift')).length, 0, r.warnings.join('\n'));
  assert.equal(r.schemaSource, 'file, plus backlinks from the app schema (--schema)');
});

test('failed verification: output kept as <out>.failed; --force keeps the old output until success', async () => {
  const src = tmpPath('force.realm');
  await make(src, [{ name: 'T', primaryKey: 'k', properties: { k: 'int', s: 'string' } }], (r) => { for (let i = 0; i < 20; i++) r.create('T', { k: i, s: 's' + i }); });
  const out = tmpPath('force.sqlite');
  assert.equal((await convert(src, out)).ok, true);
  const good = await fileSha256(out);

  const r = await convert(src, out, { force: true, _beforeVerify: (db) => db.exec(`UPDATE "T" SET "s" = 'x' WHERE "k" = 3`) });
  assert.equal(r.ok, false);
  assert.equal(r.output.path, path.resolve(out + '.failed'));
  assert.ok(fs.existsSync(out + '.failed'));
  assert.equal(await fileSha256(out), good, 'old output replaced by a failed one');
  assert.ok(r.warnings.some((w) => w.startsWith('Verification failed')));

  fs.writeFileSync(tmpPath('garbage.realm'), 'not a realm file '.repeat(500));
  await assert.rejects(convert(path.join(path.dirname(src), 'garbage.realm'), out, { force: true }));
  assert.equal(await fileSha256(out), good, 'old output deleted by a failed --force run');
  assert.equal(fs.existsSync(out + '.partial'), false);

  fs.rmSync(out);
  assert.equal((await convert(src, out, { _beforeVerify: (db) => db.exec(`DELETE FROM "T" WHERE "k" = 1`) })).ok, false);
  assert.equal(fs.existsSync(out), false, 'failed output at the final path');
  assert.equal((await convert(src, out, { force: true })).ok, true);
});

test('names that clash in SQLite get deterministic suffixes, recorded in _keel_meta', async () => {
  const schema = [
    { name: 'Item', properties: { a: 'int' } },
    { name: 'item', properties: { b: 'int' } },
    { name: 'P', properties: { name: 'string', Name: 'string', d: 'double', d__x: 'string', _RID: 'int' } },
    { name: 'A', properties: { b: 'int[]' } },
    { name: 'A__b', properties: { z: 'int' } },
    { name: '_keel_meta', properties: { key: 'string', value: 'string' } },
  ];
  const src = tmpPath('names.realm');
  await make(src, schema, (r) => {
    r.create('Item', { a: 1 });
    r.create('item', { b: 2 });
    r.create('P', { name: 'a', Name: 'b', d: NaN, d__x: 'text', _RID: 7 });
    r.create('A', { b: [1, 2] });
    r.create('A__b', { z: 3 });
    r.create('_keel_meta', { key: 'k', value: 'v' });
  });
  const out = tmpPath('names.sqlite');
  const r = await convert(src, out);
  assert.equal(r.ok, true, JSON.stringify(r.verification.mismatches));
  const db = open(out);
  const renames = JSON.parse(db.prepare(`SELECT "value" FROM "_keel_meta" WHERE "key" = 'renames'`).pluck().get());
  const got = Object.fromEntries(renames.map((x) => [`${x.class}${x.prop ? '.' + x.prop : ''}:${x.from}`, x.to]));
  assert.deepEqual(got, {
    '_keel_meta:_keel_meta': '_keel_meta_2',
    'item:item': 'item_2',
    'P.Name:Name': 'Name_2',
    'P.d__x:d__x': 'd__x_2',
    'P._RID:_RID': '_RID_2',
    'A.b:A__b': 'A__b_2',
  });
  assert.equal(db.prepare('SELECT "b" FROM "item_2"').pluck().get(), 2);
  assert.equal(db.prepare('SELECT "Name_2" FROM "P"').pluck().get(), 'b');
  assert.equal(db.prepare('SELECT "d__x" FROM "P"').pluck().get(), 'NaN');
  assert.equal(db.prepare('SELECT count(*) FROM "A__b_2"').pluck().get(), 2);
  assert.equal(db.prepare('SELECT "value" FROM "_keel_meta_2"').pluck().get(), 'v');
  const model = JSON.parse(db.prepare(`SELECT "value" FROM "_keel_meta" WHERE "key" = 'model'`).pluck().get());
  for (const [cls, query] of [['item', 'b == 2'], ['P', 'Name == "b" AND d__x == "text"'], ['A', 'b.@count == 2']]) {
    const { sql, params } = translate(query, { model, className: cls });
    assert.equal(db.prepare(sql).all(...params).length, 1, `${cls}: ${query}`);
  }
  db.close();
  assert.ok(r.warnings.some((w) => /item: table stored as "item_2"/.test(w)), r.warnings.join('\n'));

  const again = await convert(src, tmpPath('names2.sqlite'));
  assert.deepEqual(again.verification.digests, r.verification.digests);
});

test('CLI: --key prints a warning about ps; KEEL_KEY does not', () => {
  const src = tmpPath('cli-key.realm');
  fs.writeFileSync(src, 'x');
  const bin = path.resolve(import.meta.dirname, '../bin/keel-convert.mjs');
  const a = spawnSync(process.execPath, [bin, src, tmpPath('cli-key.sqlite'), '--key', 'ab'.repeat(64)], { encoding: 'utf8' });
  assert.match(a.stderr, /--key is visible .*prefer KEEL_KEY/);
  const b = spawnSync(process.execPath, [bin, src, tmpPath('cli-key.sqlite')], { encoding: 'utf8', env: { ...process.env, KEEL_KEY: 'ab'.repeat(64) } });
  assert.doesNotMatch(b.stderr, /visible/);
  assert.equal(b.status, 1);
});
