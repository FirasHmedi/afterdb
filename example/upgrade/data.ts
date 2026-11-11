/**
 * Upgrade test data (upgrade mode of the example app, entry index.upgrade.js).
 *
 * The same app is built twice with the same application id: once with the official realm@20.2.0 and once with
 * afterdb. The builds run in turn on one device (scripts/android-upgrade.sh, scripts/ios-upgrade.sh). Each run is
 * one stage, on a plain and an encrypted realm file (fixed 64-byte key):
 * 1. check every object written by the earlier stages against the values the generator gives for it, and against
 *    the SHA-256 digest that the writing stage recorded in the file (UpGeneration);
 * 2. add one generation of objects (every property type of realm-js v20 local: primitives, optionals, lists,
 *    sets, dictionaries, mixed with nested collections, counter, links, embedded objects, backlinks, a full-text
 *    index), record its digest and the name of the package that wrote it, and check everything again.
 *
 * No runtime import of "realm": the caller passes the Realm class, so this file also runs under Node.
 */
import type RealmNamespace from 'realm';

type RealmClass = typeof RealmNamespace;
type Realm = RealmNamespace;
// Values read from realm objects or produced by the generator (checked at run time, not by the type system)
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const PLAIN_PATH = 'upgrade-plain.realm';
export const ENCRYPTED_PATH = 'upgrade-encrypted.realm';
export const RESULT_PATH = 'upgrade-result.realm';
/** Fixed 64-byte test key (not a secret): the encrypted file must open with it in every stage */
export const KEY = new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff);
/** Objects added by each stage */
export const GEN_SIZE = 120;

const pkOf = (gen: number, idx: number) => gen * 10000 + idx;

// Property types, in realm's shorthand: base type, '?' for optional, then '[]' list, '<>' set or '{}' dictionary
const INNER_PROPS: [string, string][] = [
  ['label', 'string'],
  ['n', 'int'],
  ['tags', 'string[]'],
  ['when', 'date?'],
  ['any', 'mixed'],
  ['ref', 'UpItem?'],
];
const ITEM_PROPS: [string, string][] = [
  ['pk', 'int'],
  ['gen', 'int'],
  ['b', 'bool'],
  ['i', 'int'],
  ['f', 'float'],
  ['d', 'double'],
  ['s', 'string'],
  ['text', 'string'],
  ['data', 'data'],
  ['date', 'date'],
  ['dec', 'decimal128'],
  ['oid', 'objectId'],
  ['uuid', 'uuid'],
  ['mixed', 'mixed'],
  ['counter', 'counter'],
  ['optB', 'bool?'],
  ['optI', 'int?'],
  ['optF', 'float?'],
  ['optD', 'double?'],
  ['optS', 'string?'],
  ['optData', 'data?'],
  ['optDate', 'date?'],
  ['optDec', 'decimal128?'],
  ['optOid', 'objectId?'],
  ['optUuid', 'uuid?'],
  ['bools', 'bool[]'],
  ['ints', 'int[]'],
  ['floats', 'float[]'],
  ['doubles', 'double?[]'],
  ['strs', 'string[]'],
  ['datas', 'data[]'],
  ['dates', 'date[]'],
  ['decs', 'decimal128[]'],
  ['oids', 'objectId[]'],
  ['uuids', 'uuid[]'],
  ['mixeds', 'mixed[]'],
  ['intSet', 'int<>'],
  ['strSet', 'string<>'],
  ['uuidSet', 'uuid<>'],
  ['mixedSet', 'mixed<>'],
  ['intDict', 'int{}'],
  ['strDict', 'string?{}'],
  ['mixedDict', 'mixed{}'],
  ['link', 'UpItem?'],
  ['links', 'UpItem[]'],
  ['linkSet', 'UpItem<>'],
  ['linkDict', 'UpItem?{}'],
  ['inner', 'UpInner?'],
  ['inners', 'UpInner[]'],
  ['innerDict', 'UpInner?{}'],
];
/** Indexed properties ('full-text' is the full-text search index) */
const INDEXED: Record<string, true | 'full-text'> = { gen: true, b: true, s: true, date: true, oid: true, uuid: true, text: 'full-text' };

// indexed properties are non-optional primitives, so their shorthand is also a valid `type`
const props = (list: [string, string][], indexed: Record<string, true | 'full-text'> = {}): RealmNamespace.PropertiesTypes =>
  Object.fromEntries(
    list.map(([name, type]) => [name, indexed[name] ? ({ type, indexed: indexed[name] } as RealmNamespace.PropertySchema) : type]),
  );

export const schema: RealmNamespace.ObjectSchema[] = [
  { name: 'UpInner', embedded: true, properties: props(INNER_PROPS) },
  { name: 'UpItem', primaryKey: 'pk', properties: { ...props(ITEM_PROPS, INDEXED), linkedBy: { type: 'linkingObjects', objectType: 'UpItem', property: 'link' } } },
  // One row per stage: who wrote the generation, how many objects, and the SHA-256 of their canonical form
  { name: 'UpGeneration', primaryKey: 'gen', properties: { gen: 'int', writer: 'string', count: 'int', digest: 'string', at: 'date' } },
  // Updated by every stage: a counter, the writers in order, and every item in order of creation
  { name: 'UpState', primaryKey: 'id', properties: { id: 'string', stages: 'counter', writers: 'string[]', items: 'UpItem[]' } },
];

// ---------------------------------------------------------------------------------------------------------------
// Canonical form: one JSON string per object, the same for the generator's input and for an object read back

function parse(type: string) {
  let kind = '';
  let base = type;
  for (const k of ['[]', '<>', '{}']) {
    if (base.endsWith(k)) {
      kind = k;
      base = base.slice(0, -2);
    }
  }
  if (base.endsWith('?')) base = base.slice(0, -1);
  return { base, kind };
}

function hex(v: Any): string {
  const u = ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
  let s = '';
  for (let i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16);
  return s;
}

/** Link marker used by the generator (a realm object once created) */
type LinkMarker = { $link: number };
const isMarker = (v: Any): v is LinkMarker => v !== null && typeof v === 'object' && typeof v.$link === 'number';
const linkPk = (v: Any) => (v === null || v === undefined ? null : isMarker(v) ? v.$link : v.pk);

function dictKeys(R: RealmClass, v: Any): string[] {
  return v instanceof R.Dictionary ? Array.from(v.keys() as Iterable<string>) : Object.keys(v);
}

function canonMixed(R: RealmClass, v: Any): unknown {
  if (v === null || v === undefined) return ['null'];
  if (typeof v === 'number') return ['n', v];
  if (typeof v === 'string') return ['s', v];
  if (typeof v === 'boolean') return ['b', v];
  if (v instanceof Date) return ['date', v.getTime()];
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return ['data', hex(v)];
  if (v instanceof R.BSON.Decimal128) return ['dec', v.toString()];
  if (v instanceof R.BSON.ObjectId) return ['oid', v.toHexString()];
  if (v instanceof R.BSON.UUID) return ['uuid', v.toHexString()];
  if (v instanceof R.Object || isMarker(v)) return ['obj', linkPk(v)];
  if (Array.isArray(v) || v instanceof R.List) return ['list', Array.from(v as Iterable<unknown>, (x) => canonMixed(R, x))];
  if (typeof v === 'object') return ['dict', dictKeys(R, v).sort().map((k) => [k, canonMixed(R, v[k])])];
  throw new Error(`mixed value of unknown kind: ${String(v)}`);
}

function canonValue(R: RealmClass, base: string, v: Any): unknown {
  if (v === null || v === undefined) return null;
  switch (base) {
    case 'bool':
    case 'int':
    case 'float':
    case 'double':
    case 'string':
      return v;
    case 'counter':
      return typeof v === 'number' ? v : v.value;
    case 'data':
      return hex(v);
    case 'date':
      return v.getTime();
    case 'decimal128':
      return v.toString();
    case 'objectId':
    case 'uuid':
      return v.toHexString();
    case 'mixed':
      return canonMixed(R, v);
    case 'UpItem':
      return linkPk(v);
    case 'UpInner':
      return canonFields(R, INNER_PROPS, v);
  }
  throw new Error(`unknown type ${base}`);
}

function canonFields(R: RealmClass, list: [string, string][], obj: Any): unknown[] {
  return list.map(([name, type]) => {
    const { base, kind } = parse(type);
    const v = obj[name];
    if (kind === '') return canonValue(R, base, v);
    if (kind === '[]') return Array.from(v as Iterable<unknown>, (x) => canonValue(R, base, x));
    // sets have no order
    if (kind === '<>') return Array.from(v as Iterable<unknown>, (x) => JSON.stringify(canonValue(R, base, x))).sort();
    return dictKeys(R, v).sort().map((k) => [k, canonValue(R, base, v[k])]);
  });
}

export const canonItem = (R: RealmClass, obj: Any) => JSON.stringify(canonFields(R, ITEM_PROPS, obj));

// ---------------------------------------------------------------------------------------------------------------
// Deterministic generator: the values of item idx of generation gen

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima'];
const UNICODE = ['café', 'Ελληνικά', '漢字かな', 'emoji 😀🚀', 'straße', 'naïve', 'עברית', ''];
const DOUBLES = [0, -1.5, Number.MAX_VALUE, Number.MIN_VALUE, -1e-300, 2 ** 53, Math.PI];

export function makeItem(R: RealmClass, gen: number, idx: number): Any {
  const r = rng(gen * 1000003 + idx * 7919 + 17);
  const n = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
  const times = <T,>(lo: number, hi: number, f: () => T): T[] => Array.from({ length: n(lo, hi) }, f);
  const maybe = <T,>(f: () => T): T | null => (r() < 0.4 ? null : f());
  const bytes = (max: number) => {
    const u = new Uint8Array(n(0, max));
    for (let k = 0; k < u.length; k++) u[k] = n(0, 255);
    return u.buffer;
  };
  const hexOf = (len: number) => Array.from({ length: len }, () => n(0, 15).toString(16)).join('');
  const date = () => new Date(Date.UTC(1990, 0, 1) + n(0, 2 ** 40));
  const dec = () => R.BSON.Decimal128.fromString(`${n(-99999, 99999)}.${n(0, 999999)}E${n(-30, 30)}`);
  const oid = () => new R.BSON.ObjectId(hexOf(24));
  // version 4 layout: bson 4 accepts no other
  const uuid = () => new R.BSON.UUID(`${hexOf(12)}4${hexOf(3)}${pick(['8', '9', 'a', 'b'])}${hexOf(15)}`);
  const str = () => (r() < 0.5 ? `${pick(WORDS)} ${pick(UNICODE)} ${n(0, 9999)}` : pick(WORDS).repeat(n(1, 80)));
  const float = () => Math.fround((r() - 0.5) * 1e6);
  const double = () => (r() < 0.2 ? pick(DOUBLES) : (r() - 0.5) * 1e12);
  const int = () => (r() < 0.5 ? n(-1000, 1000) : Math.floor((r() - 0.5) * 2 ** 53));
  // links only to objects that exist when this one is created: earlier generations, then earlier items of this one
  const before = (gen - 1) * GEN_SIZE + idx;
  const target = (): LinkMarker | null => {
    if (before === 0) return null;
    const k = n(0, before - 1);
    return { $link: k < (gen - 1) * GEN_SIZE ? pkOf(Math.floor(k / GEN_SIZE) + 1, k % GEN_SIZE) : pkOf(gen, k - (gen - 1) * GEN_SIZE) };
  };
  const primitiveMixed = (): unknown => pick<() => unknown>([() => null, int, double, str, () => r() < 0.5, date, () => bytes(40), dec, oid, uuid])();
  const mixed = (): unknown => {
    switch (idx % 14) {
      case 0: return null;
      case 1: return n(-100000, 100000);
      case 2: return double();
      case 3: return str();
      case 4: return r() < 0.5;
      case 5: return date();
      case 6: return bytes(300);
      case 7: return dec();
      case 8: return oid();
      case 9: return uuid();
      // collections inside mixed
      case 10: return [primitiveMixed(), primitiveMixed(), [primitiveMixed(), 'nested'], { k: primitiveMixed() }];
      case 11: return { a: primitiveMixed(), b: [primitiveMixed(), primitiveMixed()], c: { d: primitiveMixed() } };
      case 12: return target() ?? 'no target';
      default: return pick(UNICODE);
    }
  };
  const inner = () => ({ label: str(), n: int(), tags: times(0, 3, str), when: maybe(date), any: primitiveMixed(), ref: target() });
  const keys = (lo: number, hi: number) => Array.from({ length: n(lo, hi) }, (_, k) => `k${k}`);
  const dict = <T,>(f: () => T) => Object.fromEntries(keys(0, 4).map((k) => [k, f()]));
  const distinct = <T,>(values: T[], key: (v: T) => string) => {
    const seen = new Set<string>();
    return values.filter((v) => !seen.has(key(v)) && !!seen.add(key(v)));
  };
  const links = times(0, 4, target).filter((x): x is LinkMarker => x !== null);
  return {
    pk: pkOf(gen, idx),
    gen,
    b: r() < 0.5,
    i: int(),
    f: float(),
    d: double(),
    s: idx % 10 === 0 ? 'shared value' : str(),
    text: `${pick(WORDS)} ${pick(WORDS)} gen${gen} item${idx}`,
    data: bytes(600),
    date: date(),
    dec: dec(),
    oid: oid(),
    uuid: uuid(),
    mixed: mixed(),
    counter: n(0, 1000),
    optB: maybe(() => r() < 0.5),
    optI: maybe(int),
    optF: maybe(float),
    optD: maybe(double),
    optS: maybe(str),
    optData: maybe(() => bytes(100)),
    optDate: maybe(date),
    optDec: maybe(dec),
    optOid: maybe(oid),
    optUuid: maybe(uuid),
    bools: times(0, 5, () => r() < 0.5),
    ints: times(0, 6, int),
    floats: times(0, 4, float),
    doubles: times(0, 4, () => maybe(double)),
    strs: times(0, 4, str),
    datas: times(0, 3, () => bytes(50)),
    dates: times(0, 3, date),
    decs: times(0, 3, dec),
    oids: times(0, 3, oid),
    uuids: times(0, 3, uuid),
    mixeds: times(0, 4, primitiveMixed),
    intSet: distinct(times(0, 6, () => n(0, 20)), String),
    strSet: distinct(times(0, 4, () => pick(WORDS)), String),
    uuidSet: times(0, 3, uuid),
    mixedSet: distinct([`s${n(0, 5)}`, n(10, 15), date()], (v) => JSON.stringify(canonMixed(R, v))),
    intDict: dict(int),
    strDict: dict(() => maybe(str)),
    mixedDict: dict(primitiveMixed),
    link: idx % 7 === 0 ? null : target(),
    links,
    linkSet: distinct(links, (x) => String(x.$link)),
    linkDict: dict(target),
    inner: maybe(inner),
    inners: times(0, 3, inner),
    // no null values: realm drops a dictionary entry set to a null embedded object
    innerDict: dict(inner),
  };
}

/** Generator values with the link markers replaced by the realm objects (for realm.create) */
function toInput(realm: Realm, list: [string, string][], values: Any): Any {
  const out: Any = {};
  const resolve = (x: Any) => (isMarker(x) ? realm.objectForPrimaryKey('UpItem', x.$link) : x);
  for (const [name, type] of list) {
    const { base, kind } = parse(type);
    const conv = (x: Any) =>
      base === 'UpItem' || base === 'mixed' ? resolve(x) : base === 'UpInner' && x !== null ? toInput(realm, INNER_PROPS, x) : x;
    const v = values[name];
    out[name] = kind === '' ? conv(v) : kind === '{}' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])) : (v as Any[]).map(conv);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// SHA-256 (no crypto module in React Native)

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function sha256(text: string): string {
  const bytes = utf8(text);
  const size = ((bytes.length + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(size);
  m.set(bytes);
  m[bytes.length] = 0x80;
  const view = new DataView(m.buffer);
  const bits = bytes.length * 8;
  view.setUint32(size - 8, Math.floor(bits / 0x100000000));
  view.setUint32(size - 4, bits >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, k: number) => (x >>> k) | (x << (32 - k));
  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => (h[i] = (h[i] + x) >>> 0));
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Checks and stages

type Generation = { gen: number; writer: string; count: number; digest: string };

const itemsOf = (realm: Realm, gen: number) => realm.objects<Any>('UpItem').filtered('gen == $0', gen).sorted('pk');
const digestOf = (R: RealmClass, realm: Realm, gen: number) => sha256(Array.from(itemsOf(realm, gen), (o) => canonItem(R, o)).join('\n'));

/** Checks everything in an open file; returns the generations found and the problems (empty if all is right) */
export function checkFile(R: RealmClass, realm: Realm): { gens: Generation[]; problems: string[] } {
  const problems: string[] = [];
  const fail = (p: string) => problems.length < 20 && problems.push(p);
  const gens: Generation[] = Array.from(realm.objects<Any>('UpGeneration').sorted('gen'), (g) => ({
    gen: g.gen,
    writer: g.writer,
    count: g.count,
    digest: g.digest,
  }));
  gens.forEach((g, k) => g.gen !== k + 1 && fail(`generation ${g.gen} at position ${k + 1}`));
  const expected = new Map<number, Any>();
  for (const g of gens) for (let idx = 0; idx < GEN_SIZE; idx++) expected.set(pkOf(g.gen, idx), makeItem(R, g.gen, idx));
  if (realm.objects('UpItem').length !== expected.size) fail(`${realm.objects('UpItem').length} items, expected ${expected.size}`);

  // every object, field by field, then the digest recorded by the stage that wrote it
  for (const g of gens) {
    const items = itemsOf(realm, g.gen);
    if (items.length !== GEN_SIZE || g.count !== GEN_SIZE) fail(`generation ${g.gen}: ${items.length} items, recorded ${g.count}`);
    let bad = 0;
    items.forEach((o, k) => {
      const want = expected.get(pkOf(g.gen, k));
      if (o.pk !== pkOf(g.gen, k) || !want || canonItem(R, o) !== canonItem(R, want)) bad++;
    });
    if (bad) fail(`generation ${g.gen}: ${bad} objects differ from the generator`);
    const digest = digestOf(R, realm, g.gen);
    if (digest !== g.digest) fail(`generation ${g.gen}: digest ${digest.slice(0, 12)}, recorded ${g.digest.slice(0, 12)}`);
  }

  // backlinks (linkingObjects of Item.link)
  const backlinks = new Map<number, number[]>();
  expected.forEach((v, pk) => {
    const to = linkPk(v.link);
    if (to !== null) backlinks.set(to, [...(backlinks.get(to) ?? []), pk]);
  });
  let badBacklinks = 0;
  for (const o of realm.objects<Any>('UpItem')) {
    const got = Array.from(o.linkedBy as Iterable<Any>, (x) => x.pk as number).sort((a, b) => a - b).join(',');
    if (got !== (backlinks.get(o.pk) ?? []).sort((a, b) => a - b).join(',')) badBacklinks++;
  }
  if (badBacklinks) fail(`${badBacklinks} objects with wrong backlinks`);

  // state object updated by every stage
  const state = realm.objectForPrimaryKey<Any>('UpState', 'state');
  if (gens.length > 0) {
    const order = gens.flatMap((g) => Array.from({ length: GEN_SIZE }, (_, idx) => pkOf(g.gen, idx))).join(',');
    if (!state) fail('no state object');
    else {
      if (state.stages.value !== gens.length) fail(`state counter ${state.stages.value}, expected ${gens.length}`);
      if (Array.from(state.writers).join(',') !== gens.map((g) => g.writer).join(',')) fail('state writers differ from the generations');
      if (Array.from(state.items as Iterable<Any>, (x) => x.pk).join(',') !== order) fail('state item list differs');
    }
  }

  // queries on the indexes (full-text, string, bool) and a sort
  const all = Array.from(expected.values());
  for (const g of gens) {
    const fts = realm.objects('UpItem').filtered('text TEXT $0', `gen${g.gen}`).length;
    if (fts !== GEN_SIZE) fail(`full-text query gen${g.gen}: ${fts}`);
    const bools = realm.objects('UpItem').filtered('b == true AND gen == $0', g.gen).length;
    if (bools !== all.filter((v) => v.b && v.gen === g.gen).length) fail(`bool query gen ${g.gen}: ${bools}`);
  }
  const shared = realm.objects('UpItem').filtered('s == $0', 'shared value').length;
  if (shared !== all.filter((v) => v.s === 'shared value').length) fail(`string index query: ${shared}`);
  if (all.length > 0) {
    const top = realm.objects<Any>('UpItem').sorted([['d', true], ['pk', false]])[0]?.pk;
    const want = [...all].sort((x, y) => y.d - x.d || x.pk - y.pk)[0].pk;
    if (top !== want) fail(`sort by double: ${top}, expected ${want}`);
  }
  return { gens, problems };
}

/** Adds the next generation in one write transaction, with its digest computed from the stored objects */
function addGeneration(R: RealmClass, realm: Realm, writer: string): number {
  const gen = realm.objects('UpGeneration').length + 1;
  realm.write(() => {
    const created: Any[] = [];
    for (let idx = 0; idx < GEN_SIZE; idx++) created.push(realm.create('UpItem', toInput(realm, ITEM_PROPS, makeItem(R, gen, idx))));
    const state: Any = realm.objectForPrimaryKey('UpState', 'state') ?? realm.create('UpState', { id: 'state', stages: 0, writers: [], items: [] });
    state.stages.increment(1);
    state.writers.push(writer);
    created.forEach((o) => state.items.push(o));
    realm.create('UpGeneration', { gen, writer, count: GEN_SIZE, digest: digestOf(R, realm, gen), at: new Date() });
  });
  return gen;
}

export type FileResult = { file: string; before: number; after: number; history: string[]; problems: string[] };
export type StageResult = { ok: boolean; stage: number; history: string[]; items: number; files: FileResult[]; text: string };

/**
 * One stage: for the plain and the encrypted file, check, add a generation, reopen and check again.
 * `dir` (Node tests only) is prepended to the file names.
 */
export function runStage(R: RealmClass, writer: string, dir = ''): StageResult {
  const at = (name: string) => (dir ? `${dir}/${name}` : name);
  const configs = [
    { file: 'plain', config: { schema, path: at(PLAIN_PATH) } as RealmNamespace.Configuration },
    { file: 'encrypted', config: { schema, path: at(ENCRYPTED_PATH), encryptionKey: KEY } as RealmNamespace.Configuration },
  ];
  const files: FileResult[] = [];
  const exist = configs.map(({ config }) => R.exists(config));
  for (const { file, config } of configs) {
    const res: FileResult = { file, before: 0, after: 0, history: [], problems: [] };
    files.push(res);
    if (exist[0] !== exist[1]) {
      res.problems.push(`plain file ${exist[0] ? 'exists' : 'missing'}, encrypted file ${exist[1] ? 'exists' : 'missing'}`);
      continue;
    }
    try {
      let realm = new R(config);
      const first = checkFile(R, realm);
      res.before = first.gens.length;
      res.problems.push(...first.problems.map((p) => `before writing: ${p}`));
      if (first.problems.length === 0) {
        addGeneration(R, realm, writer);
        realm.close();
        realm = new R(config);
        const second = checkFile(R, realm);
        res.after = second.gens.length;
        res.history = second.gens.map((g) => g.writer);
        res.problems.push(...second.problems.map((p) => `after writing: ${p}`));
      }
      realm.close();
    } catch (e) {
      res.problems.push(`error: ${String(e)}`);
    }
  }
  const [plain, encrypted] = files;
  // the encrypted file must refuse to open without the key or with another key, the plain file with a key
  // (only once both files exist: opening a missing path would create a new file)
  if (R.exists(at(PLAIN_PATH)) && R.exists(at(ENCRYPTED_PATH))) {
    const refused = [
      { res: encrypted, what: 'opened without the key', config: { schema, path: at(ENCRYPTED_PATH) } },
      { res: encrypted, what: 'opened with a wrong key', config: { schema, path: at(ENCRYPTED_PATH), encryptionKey: new Uint8Array(64).fill(7) } },
      { res: plain, what: 'opened with an encryption key', config: { schema, path: at(PLAIN_PATH), encryptionKey: KEY } },
    ];
    for (const { res, what, config } of refused) {
      try {
        new R(config).close();
        res.problems.push(what);
      } catch {
        // expected
      }
    }
  }
  const problems = files.flatMap((f) => f.problems.map((p) => `${f.file}: ${p}`));
  if (plain.after !== encrypted.after || plain.history.join(',') !== encrypted.history.join(',')) {
    problems.push('the two files have different histories');
  }
  if (plain.after !== plain.before + 1) problems.push(`plain file: ${plain.before} generations before, ${plain.after} after`);
  const stage = plain.before + 1;
  const ok = problems.length === 0;
  const text = ok
    ? `AFTERDB_UPGRADE_OK stage=${stage} history=${plain.history.join(',')} items=${plain.after * GEN_SIZE}`
    : `AFTERDB_UPGRADE_FAILED stage=${stage} ${problems.join('; ')}`;
  return { ok, stage, history: plain.history, items: plain.after * GEN_SIZE, files, text };
}
