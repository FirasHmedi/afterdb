// Fictitious test databases. No real data anywhere.
import fs from 'node:fs';
import path from 'node:path';
import Realm from 'realm';
import { mulberry32 } from '../src/verify.mjs';
import { relax } from '../src/gc.mjs';

const { ObjectId, Decimal128, UUID } = Realm.BSON;
export const TMP = path.resolve(import.meta.dirname, '../tmp');

export function tmpPath(name) {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, name);
  for (const f of fs.readdirSync(TMP)) if (f.startsWith(name)) fs.rmSync(path.join(TMP, f), { recursive: true, force: true });
  return p;
}

export const schema = [
  {
    name: 'Item', primaryKey: '_id',
    properties: {
      _id: 'int',
      i: 'int', iOpt: 'int?', b: 'bool', bOpt: 'bool?', f: 'float', fOpt: 'float?', d: 'double', dOpt: 'double?',
      s: 'string', sOpt: 'string?', bin: 'data', binOpt: 'data?', date: 'date', dateOpt: 'date?',
      dec: 'decimal128', decOpt: 'decimal128?', oid: 'objectId', oidOpt: 'objectId?', uuid: 'uuid', uuidOpt: 'uuid?',
      count: 'counter',
      mixed: 'mixed',
      owner: 'Owner?', ref: 'Item?', note: 'Note?', okey: 'ObjKeyed?',
      ints: 'int[]', intsOpt: 'int?[]', doubles: 'double[]', doublesOpt: 'double?[]', floats: 'float[]',
      strings: 'string[]', stringsOpt: 'string?[]', bools: 'bool[]', dates: 'date[]', bins: 'data[]',
      decs: 'decimal128[]', oids: 'objectId[]', uuids: 'uuid[]',
      items: 'Item[]', notes: 'Note[]',
      address: 'Address?', addresses: 'Address[]',
      tagSet: 'string<>', itemSet: 'Item<>', dict: 'double{}', mixedList: 'mixed[]',
      refBy: { type: 'linkingObjects', objectType: 'Item', property: 'ref' },
      listedIn: { type: 'linkingObjects', objectType: 'Item', property: 'items' },
      inSets: { type: 'linkingObjects', objectType: 'Item', property: 'itemSet' },
      notedBy: { type: 'linkingObjects', objectType: 'Note', property: 'item' },
    },
  },
  {
    name: 'Owner', primaryKey: 'name',
    properties: { name: 'string', since: 'date?', items: { type: 'linkingObjects', objectType: 'Item', property: 'owner' } },
  },
  { name: 'Note', properties: { text: 'string', at: 'date?', item: 'Item?', tags: 'string[]' } }, // no primary key
  { name: 'ObjKeyed', primaryKey: '_id', properties: { _id: 'objectId', v: 'int', item: 'Item?', uu: 'UuidKeyed?' } },
  { name: 'UuidKeyed', primaryKey: '_id', properties: { _id: 'uuid', label: 'string?', notes: 'Note[]' } },
  { name: 'Address', embedded: true, properties: { street: 'string', city: 'string?', geo: 'Geo?', lines: 'string[]', owner: 'Owner?', lat: 'double?' } },
  { name: 'Geo', embedded: true, properties: { lat: 'double', lng: 'double' } },
];

const EDGE_STRINGS = ['', 'É', 'Ç', 'ß', 'Ünïcödé', 'emoji 🙂🚀', 'é'.normalize('NFD'), 'tab\tnew\nline', 'quote " and \'', 'a\u0000b', 'x'.repeat(100_000)];
const EDGE_DOUBLES = [NaN, -0, 0, Infinity, -Infinity, 1.5, -2.25, Number.MAX_VALUE, Number.MIN_VALUE, 0.1 + 0.2];
const EDGE_DATES = [new Date(-2208988800000), new Date(-1), new Date(0), new Date(Date.UTC(1969, 6, 20, 20, 17)), new Date(Date.UTC(2038, 0, 19, 3, 14, 8)), new Date(253402300799999)];
const EDGE_INTS = [0, -1, 1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 31, -(2 ** 31)];

const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const bytes = (rnd, n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256); return b.buffer; };
const word = (rnd) => pick(rnd, ['alpha', 'Bravo', 'charlie', 'Delta', 'écho', 'Foxtrot', 'golf', 'ÉLAN', 'çà', 'straße', '日本', '']) + (rnd() < 0.5 ? '' : String(Math.floor(rnd() * 100)));
const oidOf = (rnd) => new ObjectId(Buffer.from(bytes(rnd, 12)).toString('hex'));
const uuidOf = (rnd) => { const h = Buffer.from(bytes(rnd, 16)).toString('hex'); return new UUID(`${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`); };

function mixedValue(rnd, realm, i, owners) {
  switch (i % 13) {
    case 0: return null;
    case 1: return true;
    case 2: return 42;
    case 3: return NaN;
    case 4: return 'mixed ' + word(rnd);
    case 5: return new Date(-86400000);
    case 6: return bytes(rnd, 5);
    case 7: return Decimal128.fromString('1234567890.123456789');
    case 8: return oidOf(rnd);
    case 9: return uuidOf(rnd);
    case 10: return owners[i % owners.length];
    case 11: return [1, 'two', null, [3]];
    default: return { a: 1, b: 'x', c: { d: false } };
  }
}

/** Database covering every supported type, edge values and all relation kinds. */
export async function makeAllTypes(file, { n = 120, encryptionKey, seed = 7 } = {}) {
  const rnd = mulberry32(seed);
  const config = { path: file, schema };
  if (encryptionKey) config.encryptionKey = encryptionKey;
  const realm = await Realm.open(config);
  realm.write(() => {
    const owners = Array.from({ length: 6 }, (_, k) => realm.create('Owner', { name: k === 0 ? '' : k === 1 ? 'Émilie Çelik' : `owner-${k}-${word(rnd)}`, since: k % 2 ? EDGE_DATES[k % EDGE_DATES.length] : null }));
    const uks = Array.from({ length: 4 }, (_, k) => realm.create('UuidKeyed', { _id: uuidOf(rnd), label: k ? word(rnd) : null }));
    const items = [];
    // Shuffled insertion order: object order differs from key order.
    const ids = Array.from({ length: n }, (_, k) => k + 1).sort(() => rnd() - 0.5);
    for (const [k, id] of ids.entries()) {
      const s = EDGE_STRINGS[k % EDGE_STRINGS.length];
      const d = EDGE_DOUBLES[k % EDGE_DOUBLES.length];
      const date = EDGE_DATES[k % EDGE_DATES.length];
      const it = realm.create('Item', {
        _id: id,
        i: EDGE_INTS[k % EDGE_INTS.length], iOpt: k % 3 ? Math.floor(rnd() * 1000) - 500 : null,
        b: k % 2 === 0, bOpt: k % 3 === 0 ? null : k % 3 === 1,
        f: [Math.fround(1.1), NaN, -0, Infinity, 3.4e38][k % 5], fOpt: k % 4 ? Math.fround(rnd()) : null,
        d, dOpt: k % 5 === 0 ? null : EDGE_DOUBLES[(k + 3) % EDGE_DOUBLES.length],
        s, sOpt: k % 4 === 0 ? null : word(rnd),
        bin: k % 6 === 0 ? new ArrayBuffer(0) : bytes(rnd, 1 + (k % 40)), binOpt: k % 2 ? bytes(rnd, 3) : null,
        date, dateOpt: k % 3 ? new Date(Math.floor(rnd() * 4e12) - 2e12) : null,
        dec: Decimal128.fromString(['0', '-0', '1.10', '9.999999999999999999999999999999999E+6144', 'NaN', 'Infinity', '-12345.678'][k % 7]),
        decOpt: k % 2 ? Decimal128.fromString(String(k) + '.5') : null,
        oid: oidOf(rnd), oidOpt: k % 2 ? null : oidOf(rnd), uuid: uuidOf(rnd), uuidOpt: k % 3 ? uuidOf(rnd) : null,
        count: k * 3,
        mixed: mixedValue(rnd, realm, k, owners),
        owner: k % 4 === 3 ? null : owners[k % owners.length],
        ints: Array.from({ length: k % 5 }, () => pick(rnd, EDGE_INTS)),
        intsOpt: k % 3 ? [1, null, 3] : [],
        doubles: EDGE_DOUBLES.slice(0, k % EDGE_DOUBLES.length + 1),
        doublesOpt: [null, NaN, -0, 2.5].slice(0, k % 5),
        floats: [Math.fround(0.1), -0, NaN].slice(0, k % 4),
        strings: EDGE_STRINGS.slice(0, k % 4).map((x) => x.slice(0, 50)),
        stringsOpt: k % 2 ? [null, 'a', ''] : [],
        bools: [true, false, true].slice(0, k % 4),
        dates: EDGE_DATES.slice(0, k % 3),
        bins: [bytes(rnd, 2), new ArrayBuffer(0)].slice(0, k % 3),
        decs: [Decimal128.fromString('0.1'), Decimal128.fromString('-1E-10')].slice(0, k % 3),
        oids: Array.from({ length: k % 3 }, () => oidOf(rnd)),
        uuids: Array.from({ length: k % 2 }, () => uuidOf(rnd)),
        address: k % 3 === 0 ? null : {
          street: s.slice(0, 30), city: k % 2 ? 'Lyon' : null, geo: k % 2 ? { lat: d, lng: -0 } : null,
          lines: ['l1', 'Ç2'].slice(0, k % 3), owner: owners[(k + 1) % owners.length], lat: k % 5 ? 45.75 : NaN,
        },
        addresses: Array.from({ length: k % 3 }, (_, j) => ({ street: `rue ${j}`, city: null, geo: { lat: j, lng: j + 0.5 }, lines: [], owner: null, lat: null })),
        tagSet: ['b', 'a', 'É', ''].slice(0, k % 5),
        dict: k % 2 ? { one: 1, nan: NaN, negZero: -0, 'clé é': Infinity } : {},
        mixedList: k % 3 ? [null, 1, 'x', new Date(5), [true]] : [],
      });
      items.push(it);
    }
    const notes = [];
    for (let k = 0; k < Math.max(10, n / 4); k++) {
      notes.push(realm.create('Note', { text: k % 5 ? `note ${k} ${word(rnd)}` : '', at: k % 2 ? EDGE_DATES[k % EDGE_DATES.length] : null, item: k % 3 ? items[k % items.length] : null, tags: ['x', 'y'].slice(0, k % 3) }));
    }
    for (const [k, it] of items.entries()) {
      it.ref = k % 3 ? items[(k * 7) % items.length] : null;
      it.note = k % 4 ? notes[k % notes.length] : null;
      it.items.push(...Array.from({ length: k % 4 }, (_, j) => items[(k + j * 11) % items.length]));
      if (k % 5 === 0) it.items.push(it); // self in list
      it.notes.push(...notes.slice(0, k % 3));
      for (const x of [items[(k + 1) % items.length], items[(k + 2) % items.length]].slice(0, k % 3)) it.itemSet.add(x);
    }
    for (let k = 0; k < 8; k++) {
      const ok = realm.create('ObjKeyed', { _id: oidOf(rnd), v: k, item: items[k], uu: k % 2 ? uks[k % uks.length] : null });
      items[k + 10].okey = ok;
    }
    uks[1].notes.push(notes[0], notes[1], notes[0]);
  });
  realm.close();
}

/** Simple wide-ish class for the scale test. */
export const scaleSchema = [
  { name: 'Row', primaryKey: '_id', properties: { _id: 'int', name: 'string', score: 'double', at: 'date', flag: 'bool', parent: 'Row?', tags: 'string[]', vals: 'double[]' } },
];

export async function makeScale(file, n, { seed = 3 } = {}) {
  const rnd = mulberry32(seed);
  const realm = await Realm.open({ path: file, schema: scaleSchema });
  const chunk = 5000;
  for (let base = 0; base < n; base += chunk) {
    realm.write(() => {
      for (let i = base; i < Math.min(n, base + chunk); i++) {
        realm.create('Row', {
          _id: i, name: `row ${i} ${word(rnd)}`, score: i % 997 === 0 ? NaN : rnd() * 1000, at: new Date(1e12 + i * 1000), flag: i % 2 === 0,
          parent: i > 0 ? realm.objectForPrimaryKey('Row', Math.floor(rnd() * i)) : null,
          tags: ['a', 'b', 'c'].slice(0, i % 4), vals: [rnd(), -0].slice(0, i % 3),
        });
      }
    });
    await relax();
  }
  realm.close();
  await relax();
}
