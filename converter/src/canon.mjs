// Canonical serialization used by verification. Two independent readers:
// canonRealm() reads SDK objects, canonSql() reads SQLite rows. Both must
// produce the same JSON for the same data. This code does not reuse the
// write path in values.mjs on purpose.
import { createHash } from 'node:crypto';
import Realm from 'realm';
import { q } from './model.mjs';
import { objectKey, classOf, dictEntries, record } from './sdk.mjs';
import { relax, due, pause } from './gc.mjs';

const { ObjectId, Decimal128, UUID } = Realm.BSON;

export function stable(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Object.is(v, -0)) throw new Error('non canonical number');
    return JSON.stringify(v);
  }
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  return JSON.stringify(v);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function canonFloat(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (Object.is(v, -0)) return '-0';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return v;
}
const hex = (u8) => Buffer.from(u8).toString('hex');
const sortCanon = (arr) => arr.map((e) => [stable(e), e]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);

// ---------- SDK side ----------

function scalarR(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'int':
      if (typeof v === 'object') v = v.value; // Counter
      return typeof v === 'bigint' ? Number(v) : v;
    case 'bool': return v === true;
    case 'float': case 'double': return canonFloat(v);
    case 'string': return String(v);
    case 'data': return hex(new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer));
    case 'date': return v.getTime();
    case 'decimal128': return v.toString();
    case 'objectId': return v.toHexString().toLowerCase();
    case 'uuid': return v.toHexString(true).toLowerCase();
    default: throw new Error(`scalarR ${type}`);
  }
}

export function keyR(model, cls, obj) {
  const t = model.classes[cls];
  if (t.key.synthetic) return Number(objectKey(obj));
  return scalarR(t.key.type, obj[t.key.column]);
}

function elemR(model, elem, v) {
  if (v === null || v === undefined) return null;
  if (elem.type === 'object') return keyR(model, elem.target, v);
  if (elem.type === 'embedded') return embeddedR(model, elem.target, v);
  if (elem.type === 'mixed') return mixedR(model, v);
  return scalarR(elem.type, v);
}

function embeddedR(model, name, obj) {
  if (obj === null || obj === undefined) return null;
  const out = record();
  for (const [n, d] of Object.entries(model.embedded[name].props)) out[n] = propR(model, d, obj[n]);
  return out;
}

function mixedR(model, v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'number') return { t: 'number', v: canonFloat(v) };
  if (typeof v === 'bigint') return { t: 'int', v: v.toString() };
  if (typeof v === 'string') return { t: 'string', v };
  if (v instanceof Date) return { t: 'date', v: v.getTime() };
  if (v instanceof ArrayBuffer) return { t: 'data', v: hex(new Uint8Array(v)) };
  if (v instanceof Decimal128) return { t: 'decimal128', v: v.toString() };
  if (v instanceof ObjectId) return { t: 'objectId', v: v.toHexString() };
  if (v instanceof UUID) return { t: 'uuid', v: v.toHexString(true) };
  if (v instanceof Realm.Object) {
    const c = classOf(v);
    return { t: 'link', c, v: keyR(model, c, v) };
  }
  if (v instanceof Realm.Dictionary) {
    const o = record();
    for (const [k, e] of dictEntries(v)) o[k] = mixedR(model, e);
    return { t: 'dictionary', v: o };
  }
  if (v instanceof Realm.List) return { t: 'list', v: [...v].map((e) => mixedR(model, e)) };
  if (typeof v === 'object' && 'value' in v) return { t: 'int', v: String(v.value) };
  throw new Error('mixedR: unknown value');
}

function propR(model, d, v) {
  switch (d.kind) {
    case 'scalar': return scalarR(d.type, v);
    case 'link': return v ? keyR(model, d.target, v) : null;
    case 'embedded': return d.many ? [...v].map((e) => embeddedR(model, d.target, e)) : embeddedR(model, d.target, v);
    case 'list': return [...v].map((e) => elemR(model, d.elem, e));
    case 'json':
      if (d.ctype === 'mixed') return mixedR(model, v);
      if (d.ctype === 'dictionary') {
        const o = record();
        for (const [k, e] of dictEntries(v)) o[k] = elemR(model, d.elem, e);
        return o;
      }
      if (d.ctype === 'set') return sortCanon([...v].map((e) => elemR(model, d.elem, e)));
      return [...v].map((e) => elemR(model, d.elem, e));
    default: throw new Error(`propR ${d.kind}`);
  }
}

/**
 * Backlinks of the source, computed from the forward links: the file stores no
 * backlink property, and linkingObjects() breaks when a stored property hides
 * an SDK method (see sdk.mjs). For each origin (class, property) used by the
 * model, maps the key of each target to the sorted keys of the objects that
 * link to it, once per link (a list that holds a target twice counts twice,
 * as in the SDK). Built once per verification, yielding to the GC as it goes.
 * @returns {(d: object, cls: string, obj: object) => Array} backlink keys of obj
 */
export async function backlinkIndex(realm, model) {
  const index = new Map();
  for (const t of Object.values(model.classes)) {
    for (const d of Object.values(t.props)) {
      if (d.kind !== 'backlink') continue;
      const id = JSON.stringify([d.source, d.sourceProp]);
      if (index.has(id)) continue;
      const sp = model.classes[d.source].props[d.sourceProp];
      const target = sp.kind === 'link' ? sp.target : sp.elem.target;
      const by = new Map();
      const add = (x, s) => {
        if (x === null || x === undefined) return;
        const k = stable(keyR(model, target, x));
        const a = by.get(k);
        if (a) a.push(s);
        else by.set(k, [s]);
      };
      const objs = realm.objects(d.source);
      for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        const v = o[d.sourceProp];
        const s = keyR(model, d.source, o);
        if (sp.kind === 'link') add(v, s);
        else if (sp.kind === 'list' || sp.ctype === 'set') for (const x of v) add(x, s);
        else for (const [, x] of dictEntries(v)) add(x, s);
        if (i % 10000 === 9999) await relax();
        else if (due()) await pause();
      }
      for (const a of by.values()) a.sort(cmpKey);
      index.set(id, by);
    }
  }
  return (d, cls, obj) => [...(index.get(JSON.stringify([d.source, d.sourceProp])).get(stable(keyR(model, cls, obj))) ?? [])];
}

/** Canonical object read from the SDK. Backlinks (from backlinkIndex) become sorted key arrays. */
export function canonRealm(model, cls, obj, backlinks) {
  const t = model.classes[cls];
  const out = record();
  out[t.key.synthetic ? '_rid' : t.key.column] = keyR(model, cls, obj);
  for (const [n, d] of Object.entries(t.props)) {
    out[n] = d.kind === 'backlink' ? backlinks(d, cls, obj) : propR(model, d, obj[n]);
  }
  return out;
}

/** Per-property canonical values (for the field-by-field sample). */
export function canonRealmField(model, cls, obj, prop, backlinks) {
  const d = model.classes[cls].props[prop];
  if (d.kind === 'backlink') return backlinks(d, cls, obj);
  return propR(model, d, obj[prop]);
}

export function cmpKey(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------- SQLite side ----------

function scalarS(type, v, special) {
  if (type === 'float' || type === 'double') {
    if (special === 'NaN') return 'NaN';
    if (special === '-0') return '-0';
    if (v === null || v === undefined) return null;
    return canonFloat(v);
  }
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'int': return typeof v === 'bigint' ? Number(v) : v;
    case 'bool': return v === 1;
    case 'string': return v;
    case 'data': return hex(v);
    case 'date': return Number(v);
    case 'decimal128': return v;
    case 'objectId': case 'uuid': return String(v).toLowerCase();
    default: throw new Error(`scalarS ${type}`);
  }
}

function jsonScalarS(type, j) {
  if (j === null || j === undefined) return null;
  if (type === 'float' || type === 'double') {
    if (typeof j === 'string') return j; // NaN, -0, Infinity, -Infinity
    return canonFloat(j);
  }
  if (type === 'data') return Buffer.from(j, 'base64').toString('hex');
  if (type === 'bool') return j === true;
  if (type === 'int') return typeof j === 'string' ? Number(j) : j;
  if (type === 'objectId' || type === 'uuid') return j.toLowerCase();
  return j;
}

function jsonElemS(model, elem, j) {
  if (j === null || j === undefined) return null;
  if (elem.type === 'object') return j;
  if (elem.type === 'embedded') return jsonEmbeddedS(model, elem.target, j);
  if (elem.type === 'mixed') return jsonMixedS(j);
  return jsonScalarS(elem.type, j);
}

function jsonPropS(model, d, j) {
  switch (d.kind) {
    case 'scalar': return jsonScalarS(d.type, j);
    case 'link': return j ?? null;
    case 'embedded': return d.many ? j.map((e) => jsonEmbeddedS(model, d.target, e)) : jsonEmbeddedS(model, d.target, j);
    case 'list': return j.map((e) => jsonElemS(model, d.elem, e));
    case 'json': return jsonCollectionS(model, d, j);
    default: throw new Error(`jsonPropS ${d.kind}`);
  }
}

function jsonEmbeddedS(model, name, j) {
  if (j === null || j === undefined) return null;
  const out = record();
  for (const [n, d] of Object.entries(model.embedded[name].props)) out[n] = jsonPropS(model, d, j[n]);
  return out;
}

function jsonMixedS(j) {
  if (j === null || j === undefined) return null;
  switch (j.t) {
    case 'number': return { t: 'number', v: typeof j.v === 'string' ? j.v : canonFloat(j.v) };
    case 'data': return { t: 'data', v: Buffer.from(j.v, 'base64').toString('hex') };
    case 'int': return { t: 'int', v: String(j.v) };
    case 'list': return { t: 'list', v: j.v.map(jsonMixedS) };
    case 'dictionary': {
      const o = record();
      for (const k of Object.keys(j.v)) o[k] = jsonMixedS(j.v[k]);
      return { t: 'dictionary', v: o };
    }
    case 'link': return { t: 'link', c: j.c, v: j.v };
    default: return { t: j.t, v: j.v };
  }
}

function jsonCollectionS(model, d, j) {
  if (d.ctype === 'mixed') return jsonMixedS(j);
  if (d.ctype === 'dictionary') {
    const o = record();
    for (const k of Object.keys(j)) o[k] = jsonElemS(model, d.elem, j[k]);
    return o;
  }
  const arr = j.map((e) => jsonElemS(model, d.elem, e));
  return d.ctype === 'set' ? sortCanon(arr) : arr;
}

/** Prepared statements for list tables and backlink views of one class. */
export function sqlReaders(db, model, cls) {
  const t = model.classes[cls];
  const r = record();
  for (const [n, d] of Object.entries(t.props)) {
    if (d.kind === 'list') {
      const cols = d.elem.type === 'object' ? '"target" AS v, NULL AS x' : `"value" AS v, ${d.elem.special ? q(d.elem.special) : 'NULL'} AS x`;
      r[n] = db.prepare(`SELECT ${cols} FROM ${q(d.table)} WHERE "owner" = ? ORDER BY "pos"`).raw();
    } else if (d.kind === 'backlink') {
      r[n] = db.prepare(`SELECT "source" FROM ${q(d.view)} WHERE "owner" = ?`).pluck();
    }
  }
  return r;
}

function sqlFieldOf(model, d, row, key, readers, n) {
  switch (d.kind) {
    case 'scalar': return scalarS(d.type, row[d.column], d.special ? row[d.special] : null);
    case 'link': {
      const v = row[d.column];
      return v === null ? null : typeof v === 'bigint' ? Number(v) : v;
    }
    case 'embedded': case 'json': {
      const s = row[d.column];
      if (s === null) return null;
      return jsonPropS(model, d, JSON.parse(s));
    }
    case 'list':
      return readers[n].all(key).map(([v, x]) => (d.elem.type === 'object' ? v : scalarS(d.elem.type, v, x)));
    case 'backlink':
      return readers[n].all(key).sort(cmpKey);
    default: throw new Error(`sqlField ${d.kind}`);
  }
}

/** Canonical object read from a SQLite row. */
export function canonSql(model, cls, row, readers) {
  const t = model.classes[cls];
  const kc = t.key.synthetic ? '_rid' : t.key.column;
  const key = typeof row[kc] === 'bigint' ? Number(row[kc]) : scalarS(t.key.type, row[kc], null);
  const out = record();
  out[kc] = key;
  for (const [n, d] of Object.entries(t.props)) out[n] = sqlFieldOf(model, d, row, row[kc], readers, n);
  return out;
}
