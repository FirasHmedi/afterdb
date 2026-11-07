import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Realm from 'realm';
import Database from 'better-sqlite3';
import { convert, verifyFile, fileSha256 } from '../src/convert.mjs';
import { makeAllTypes, tmpPath, schema, TMP } from './fixtures.mjs';

after(() => Realm.shutdown());

function assertClean(r) {
  const v = r.verification;
  assert.equal(r.input.unchanged, true, 'source SHA-256 changed');
  assert.equal(v.mismatchCount, 0, JSON.stringify(v.mismatches.slice(0, 5)));
  assert.equal(v.sample.mismatchCount, 0, JSON.stringify(v.sample.mismatches.slice(0, 5)));
  assert.equal(v.foreignKeyCheck.violations, 0);
  assert.equal(v.integrityCheck, 'ok');
  assert.ok(v.tables.every((t) => t.ok && t.objects === t.rows));
  assert.ok(v.lists.every((t) => t.ok));
  assert.ok(v.views.every((t) => t.ok));
  assert.ok(v.digests.every((d) => d.equal));
  assert.equal(v.lossy.realm, v.lossy.sqlite);
  assert.equal(r.ok, true);
}

test('all types, with app schema: zero mismatches, source unchanged', async () => {
  const src = tmpPath('all.realm');
  await makeAllTypes(src);
  const sha = await fileSha256(src);
  const out = tmpPath('all.sqlite');
  const r = await convert(src, out, { schema, report: path.join(TMP, 'report-all'), sample: 300 });
  assertClean(r);
  assert.equal(await fileSha256(src), sha);
  assert.ok(r.verification.sample.fields > 1000);
  assert.ok(r.verification.lossy.realm > 0, 'fixture must contain NaN/Infinity/-0');
  assert.ok(fs.existsSync(path.join(TMP, 'report-all/report.md')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'report-all/report.json'))).ok, true);

  const db = new Database(out, { readonly: true });
  const sql = (n) => db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').pluck().get(n);
  assert.match(sql('Item'), /WITHOUT ROWID/);
  assert.match(sql('Item'), /"owner" TEXT REFERENCES "Owner"\("name"\)/);
  assert.match(sql('Item'), /"note" INTEGER REFERENCES "Note"\("_rid"\)/);
  assert.match(sql('Item'), /"b" INTEGER NOT NULL CHECK \("b" IN \(0,1\)\)/);
  assert.match(sql('Item'), /"address" TEXT CHECK \(json_valid\("address"\)\)/);
  assert.doesNotMatch(sql('Note'), /WITHOUT ROWID/);
  assert.match(sql('Note'), /"_rid" INTEGER PRIMARY KEY/);
  assert.match(sql('Item__items'), /"target" INTEGER NOT NULL REFERENCES "Item"\("_id"\) ON DELETE CASCADE/);
  assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name = 'Owner__items'").pluck().get(), 'view');
  // Edge values as stored.
  assert.ok(db.prepare(`SELECT count(*) FROM "Item" WHERE "d" IS NULL AND "d__x" = 'NaN'`).pluck().get() > 0);
  assert.ok(db.prepare(`SELECT count(*) FROM "Item__doubles" WHERE "value" = 0 AND "value__x" = '-0'`).pluck().get() > 0);
  assert.ok(db.prepare(`SELECT count(*) FROM "Item" WHERE "d" = 9e999`).pluck().get() > 0);
  assert.ok(db.prepare(`SELECT count(*) FROM "Item" WHERE "date" = -2208988800000`).pluck().get() > 0);
  assert.ok(db.prepare(`SELECT count(*) FROM "Item" WHERE "s" = 'emoji 🙂🚀'`).pluck().get() > 0);
  assert.ok(db.prepare(`SELECT count(*) FROM "Item" WHERE length("s") = 100000`).pluck().get() > 0);
  assert.equal(db.prepare(`SELECT count(*) FROM "Item" WHERE "dec" = '9.999999999999999999999999999999999E+6144'`).pluck().get() > 0, true);
  // Backlink view equals the SDK's linkingObjects.
  const realm = await Realm.open({ path: src, schema, readOnly: true });
  const it = realm.objectForPrimaryKey('Item', 5);
  const viaView = db.prepare('SELECT source FROM "Item__listedIn" WHERE owner = 5 ORDER BY source').pluck().all();
  assert.deepEqual(viaView, [...it.listedIn].map((x) => x._id).sort((a, b) => a - b));
  realm.close();
  db.close();
});

test('without app schema: converts, warns that backlinks are missing', async () => {
  const src = tmpPath('noschema.realm');
  await makeAllTypes(src, { n: 40 });
  const r = await convert(src, tmpPath('noschema.sqlite'), {});
  assertClean(r);
  assert.ok(r.warnings.some((w) => w.includes('backlinks')));
  assert.equal(r.verification.views.length, 0);
});

test('encrypted source (64-byte key)', async () => {
  const key = randomBytes(64);
  const src = tmpPath('enc.realm');
  await makeAllTypes(src, { n: 60, encryptionKey: key, seed: 11 });
  const header = fs.readFileSync(src).subarray(0, 4096);
  assert.equal(header.includes(Buffer.from('Note')), false, 'file should be encrypted');
  await assert.rejects(convert(src, tmpPath('enc-nokey.sqlite'), { schema }));
  const r = await convert(src, tmpPath('enc.sqlite'), { schema, key: key.toString('hex') });
  assertClean(r);
  assert.equal(r.input.encrypted, true);
  await assert.rejects(convert(src, tmpPath('x.sqlite'), { key: 'abc' }), /128 hex/);
});

test('verification detects tampering', async () => {
  const src = tmpPath('tamper.realm');
  await makeAllTypes(src, { n: 50, seed: 5 });
  const out = tmpPath('tamper.sqlite');
  assertClean(await convert(src, out, { schema }));
  const db = new Database(out);
  db.pragma('foreign_keys = OFF'); // better-sqlite3 enables them by default
  db.exec(`UPDATE "Item" SET "s" = "s" || '!' WHERE "_id" = 3`); // changed value
  db.exec(`UPDATE "Item" SET "d" = NULL, "d__x" = NULL WHERE "d__x" = 'NaN' AND "_id" = (SELECT min("_id") FROM "Item" WHERE "d__x" = 'NaN')`); // NaN lost
  db.exec(`DELETE FROM "Item__ints" WHERE ("owner", "pos") = (SELECT "owner", "pos" FROM "Item__ints" LIMIT 1)`); // list element gone
  db.exec(`DELETE FROM "Note" WHERE "_rid" = (SELECT min("_rid") FROM "Note")`); // row gone, FK now dangling
  db.close();
  const { verification: v, sourceUnchanged } = await verifyFile(src, out, { schema, sample: 1000 });
  assert.equal(sourceUnchanged, true);
  assert.equal(v.ok, false);
  assert.ok(v.mismatchCount >= 4, `mismatches: ${v.mismatchCount}`);
  assert.ok(v.mismatches.some((m) => m.class === 'Item' && m.key === 3 && m.fields.includes('s')));
  assert.ok(v.mismatches.some((m) => m.reason === 'object missing in SQLite'));
  assert.ok(v.foreignKeyCheck.violations > 0);
  assert.ok(v.lists.some((l) => !l.ok));
  assert.ok(v.digests.some((d) => !d.equal));
  assert.ok(v.sample.mismatchCount > 0);
});

test('CLI: report files, exit code, refuses to overwrite', () => {
  const src = path.join(TMP, 'all.realm');
  const out = tmpPath('cli.sqlite');
  const rep = path.join(TMP, 'report-cli');
  fs.rmSync(rep, { recursive: true, force: true });
  const bin = path.resolve(import.meta.dirname, '../bin/afterdb-convert.mjs');
  const schemaFile = path.join(TMP, 'schema-cli.mjs');
  fs.writeFileSync(schemaFile, `export { schema } from ${JSON.stringify(path.resolve(import.meta.dirname, 'fixtures.mjs'))};\n`);
  const stdout = execFileSync(process.execPath, [bin, src, out, '--schema', schemaFile, '--report', rep], { encoding: 'utf8' });
  assert.match(stdout, /^OK: /);
  assert.ok(fs.existsSync(path.join(rep, 'report.json')) && fs.existsSync(path.join(rep, 'report.md')));
  const again = spawnSync(process.execPath, [bin, src, out], { encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /output exists/);
  const badKey = spawnSync(process.execPath, [bin, src, tmpPath('cli2.sqlite'), '--key', 'zz'], { encoding: 'utf8' });
  assert.equal(badKey.status, 1);
  assert.match(badKey.stderr, /128 hex/);
});
