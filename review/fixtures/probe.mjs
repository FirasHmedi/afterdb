// Run with the "realm" package resolved from the current folder. Prints one JSON object describing behaviour.
// Usage: node probe.mjs <dir>   (dir: where to create files)
import Realm from 'realm';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const { ObjectId, Decimal128, UUID } = Realm.BSON;
const dir = process.argv[2];
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const out = {};
const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e.constructor?.name, message: String(e.message).slice(0, 160) }; } };

const Addr = { name: 'Addr', embedded: true, properties: { city: 'string', zip: 'string?' } };
const Person = {
  name: 'Person', primaryKey: '_id',
  properties: {
    _id: 'objectId', uuid: 'uuid', dec: 'decimal128', name: 'string', age: 'int?', h: 'double?', f: 'float?',
    born: 'date?', data: 'data?', addr: 'Addr?', addrs: 'Addr[]', tags: 'string<>', dict: 'string{}', any: 'mixed',
    friends: 'Person[]', counter: { type: 'int', presentation: 'counter', default: 0 },
    followers: { type: 'linkingObjects', objectType: 'Person', property: 'friends' },
  },
};
const id1 = new ObjectId('64b7f0a1c2d3e4f5a6b7c8d9');

await step('types', async () => {
  const r = await Realm.open({ path: join(dir, 'types.realm'), schema: [Person, Addr] });
  r.write(() => {
    const a = r.create('Person', { _id: id1, uuid: new UUID('8f14e45f-ceea-467f-a9f3-7c2e4b5d6a7b'), dec: Decimal128.fromString('-0.000000000000000000000000000000001'), name: 'Zoë 🐟', age: 41, h: NaN, f: 1.1, born: new Date(-1), data: new Uint8Array([0, 255, 1]), addr: { city: 'Tunis' }, addrs: [{ city: 'A' }, { city: 'B', zip: '1000' }], tags: ['x', 'y', 'x'], dict: { k: 'v', 'é': 'ü' }, any: { nested: [1, 'two', { three: 3 }] } });
    const b = r.create('Person', { _id: new ObjectId(), uuid: new UUID(), dec: Decimal128.fromString('NaN'), name: 'b', addrs: [], tags: [], dict: {}, any: null, friends: [a] });
    a.counter.increment(5);
  });
  const p = r.objectForPrimaryKey('Person', id1);
  const res = {
    dec: p.dec.toString(), uuid: p.uuid.toString(), h: String(p.h), f: p.f, born: p.born.getTime(), data: [...new Uint8Array(p.data)],
    addr: p.addr.city, addrs: p.addrs.map((x) => x.zip ?? null), tags: [...p.tags].sort(), dict: { ...p.dict }, any: JSON.parse(JSON.stringify(p.any)),
    counter: p.counter.value, followers: p.followers.length,
    q1: r.objects('Person').filtered('name CONTAINS[c] "zoË"').length,
    q2: r.objects('Person').filtered('ANY tags == "x"').length,
    q3: r.objects('Person').filtered('addr.city == "Tunis"').length,
    q4: r.objects('Person').filtered('dict.k == "v"').length,
    q5: r.objects('Person').filtered('@links.Person.friends.@count > 0').length,
  };
  r.close();
  return res;
});

await step('migration', async () => {
  const path = join(dir, 'mig.realm');
  const V1 = { name: 'T', primaryKey: '_id', properties: { _id: 'int', first: 'string', last: 'string' } };
  const V2 = { name: 'T', primaryKey: '_id', properties: { _id: 'int', full: 'string', n: { type: 'int', default: 7 } } };
  let r = await Realm.open({ path, schema: [V1], schemaVersion: 1 });
  r.write(() => { r.create('T', { _id: 1, first: 'Ada', last: 'L' }); });
  r.close();
  let called = 0;
  r = await Realm.open({ path, schema: [V2], schemaVersion: 2, onMigration: (o, n) => { called++; const ol = o.objects('T'); const nl = n.objects('T'); for (let i = 0; i < ol.length; i++) nl[i].full = ol[i].first + ' ' + ol[i].last; } });
  const t = r.objectForPrimaryKey('T', 1);
  const res = { called, full: t.full, n: t.n, version: Realm.schemaVersion(path) };
  r.close();
  let mismatch = null;
  try { await Realm.open({ path, schema: [V1], schemaVersion: 1 }); } catch (e) { mismatch = e.constructor.name; }
  res.downgradeRefused = mismatch;
  return res;
});

await step('listeners', async () => {
  const r = await Realm.open({ path: join(dir, 'l.realm'), schema: [{ name: 'X', properties: { v: 'int' } }] });
  const events = [];
  const results = r.objects('X');
  const done = new Promise((resolve) => {
    results.addListener((col, ch) => { events.push({ len: col.length, ins: ch.insertions.length, del: ch.deletions.length, mod: ch.newModifications.length }); if (events.length === 4) resolve(); });
  });
  await new Promise((res) => setTimeout(res, 50));
  r.write(() => { r.create('X', { v: 1 }); r.create('X', { v: 2 }); });
  await new Promise((res) => setTimeout(res, 50));
  r.write(() => { results[0].v = 10; });
  await new Promise((res) => setTimeout(res, 50));
  r.write(() => { r.delete(results[1]); });
  await Promise.race([done, new Promise((res) => setTimeout(res, 2000))]);
  let objEvents = 0;
  const o = results[0];
  o.addListener(() => { objEvents++; });
  await new Promise((res) => setTimeout(res, 50));
  r.write(() => { o.v = 11; });
  await new Promise((res) => setTimeout(res, 100));
  r.removeAllListeners?.();
  results.removeAllListeners();
  r.close();
  return { events, objEvents };
});

await step('copyBundledRealmFiles', async () => (typeof Realm.copyBundledRealmFiles === 'function' ? (() => { try { Realm.copyBundledRealmFiles(); return 'ok'; } catch (e) { return 'throws: ' + String(e.message).slice(0, 80); } })() : typeof Realm.copyBundledRealmFiles));

await step('deleteFile', async () => {
  const path = join(dir, 'del.realm');
  const r = new Realm({ path, schema: [{ name: 'D', properties: { a: 'int' } }] });
  r.close();
  const { existsSync } = await import('node:fs');
  const before = existsSync(path);
  Realm.deleteFile({ path });
  return { before, after: existsSync(path), exists: Realm.exists({ path }) };
});

await step('asyncOpenAndCompact', async () => {
  const path = join(dir, 'c.realm');
  const r = await Realm.open({ path, schema: [{ name: 'C', properties: { s: 'string' } }] });
  r.write(() => { for (let i = 0; i < 2000; i++) r.create('C', { s: 'x'.repeat(1000) }); });
  r.write(() => r.delete(r.objects('C')));
  const ok = r.compact();
  r.close();
  return { compact: ok };
});

await step('inMemoryAndReadOnly', async () => {
  const m = await Realm.open({ path: join(dir, 'mem.realm'), inMemory: true, schema: [{ name: 'M', properties: { a: 'int' } }] });
  m.write(() => m.create('M', { a: 1 }));
  const n = m.objects('M').length;
  m.close();
  const path = join(dir, 'ro.realm');
  const w = await Realm.open({ path, schema: [{ name: 'R', properties: { a: 'int' } }] });
  w.write(() => w.create('R', { a: 1 }));
  w.close();
  const ro = await Realm.open({ path, readOnly: true, schema: [{ name: 'R', properties: { a: 'int' } }] });
  let writeRefused = false;
  try { ro.write(() => ro.create('R', { a: 2 })); } catch { writeRefused = true; }
  ro.close();
  return { n, writeRefused };
});

await step('version', async () => ({ coreVersion: typeof Realm.App, flags: Object.keys(Realm.flags ?? {}).sort() }));

console.log(JSON.stringify(out));
process.exit(0);
