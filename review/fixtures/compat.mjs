// node compat.mjs write|read <file>: writes a file, or reads it back and prints a digest
import Realm from 'realm';
const { ObjectId, Decimal128, UUID } = Realm.BSON;
const [mode, path, keyHex] = process.argv.slice(2);
const encryptionKey = keyHex ? Buffer.from(keyHex, 'hex') : undefined;
const E = { name: 'E', embedded: true, properties: { s: 'string' } };
const K = { name: 'K', primaryKey: '_id', properties: { _id: 'uuid', o: 'objectId', d: 'decimal128', s: 'string', l: 'int[]', set: 'string<>', dict: 'mixed{}', e: 'E?', link: 'K?', dt: 'date' } };
const cfg = { path, schema: [K, E], schemaVersion: 3, encryptionKey };
if (mode === 'write') {
  const r = await Realm.open(cfg);
  r.write(() => {
    let prev = null;
    for (let i = 0; i < 500; i++) prev = r.create('K', { _id: new UUID(), o: new ObjectId(), d: Decimal128.fromString(`${i}.5`), s: 'é'.repeat(i % 7) + i, l: [i, -i], set: ['a', String(i % 3)], dict: { n: i, s: 'x', nested: [i] }, e: { s: 'e' + i }, link: prev, dt: new Date(1e12 + i) });
  });
  r.close();
  console.log('written');
} else {
  const r = await Realm.open(cfg);
  const all = r.objects('K').sorted('s');
  const digest = all.map((k) => [k.s, k.d.toString(), [...k.l].join(','), [...k.set].sort().join(','), JSON.stringify(k.dict), k.e?.s, k.link?.s ?? null, k.dt.getTime()].join('|')).join('\n');
  const { createHash } = await import('node:crypto');
  console.log(JSON.stringify({ n: all.length, sha: createHash('sha256').update(digest).digest('hex'), q: r.objects('K').filtered('s BEGINSWITH "é" AND link.s != nil').length }));
  r.close();
}
process.exit(0);
