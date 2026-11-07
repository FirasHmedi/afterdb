// Encoding of SDK values into SQLite values and JSON text (write path).
import Realm from 'realm';
import { objectKey, classOf, dictEntries, record } from './sdk.mjs';

const { ObjectId, Decimal128, UUID } = Realm.BSON;

export function bytesOf(v) {
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v)); // copy
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  throw new TypeError('expected binary data');
}

export function intOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && 'value' in v) v = v.value; // Counter
  if (typeof v === 'bigint') return v;
  return v;
}

/** [real, special] pair: NaN -> (NULL,'NaN'), -0 -> (0,'-0'). */
export function floatPair(v) {
  if (v === null || v === undefined) return [null, null];
  if (Number.isNaN(v)) return [null, 'NaN'];
  if (Object.is(v, -0)) return [0, '-0'];
  return [v, null];
}

/** Single SQLite value for a non-float scalar. */
export function scalarToSql(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'int': return intOf(v);
    case 'bool': return v ? 1 : 0;
    case 'string': return v;
    case 'data': return bytesOf(v);
    case 'date': {
      const ms = v.getTime();
      if (Number.isNaN(ms)) throw new RangeError('invalid date');
      return ms;
    }
    case 'decimal128': return v.toString();
    case 'objectId': return v.toHexString();
    case 'uuid': return v.toString();
    default: throw new Error(`not a plain scalar: ${type}`);
  }
}

/** Key value of an object as stored in SQLite (PK value or synthetic _rid). */
export function keyToSql(model, className, obj) {
  const t = model.classes[className];
  if (t.key.synthetic) {
    const k = BigInt(objectKey(obj));
    return k <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(k) : k;
  }
  return scalarToSql(t.key.type, obj[t.key.column]);
}

function floatJson(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (Object.is(v, -0)) return '-0';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return v;
}

function scalarJson(type, v) {
  if (v === null || v === undefined) return null;
  if (type === 'float' || type === 'double') return floatJson(v);
  if (type === 'data') return bytesOf(v).toString('base64');
  if (type === 'bool') return !!v;
  const s = scalarToSql(type, v);
  return typeof s === 'bigint' ? s.toString() : s;
}

/** JSON-ready value for an element descriptor {type, target}. */
export function toJson(model, desc, v) {
  if (v === null || v === undefined) return null;
  switch (desc.type) {
    case 'object': return keyToSql(model, desc.target, v);
    case 'embedded': return embeddedToJson(model, desc.target, v);
    case 'mixed': return mixedToJson(model, v);
    default: return scalarJson(desc.type, v);
  }
}

export function embeddedToJson(model, name, obj) {
  if (obj === null || obj === undefined) return null;
  const out = record();
  for (const [n, d] of Object.entries(model.embedded[name].props)) {
    out[n] = propToJson(model, d, obj[n]);
  }
  return out;
}

/** Any property (scalar, link, embedded, collection) as a JSON-ready value. */
export function propToJson(model, d, v) {
  switch (d.kind) {
    case 'scalar': return scalarJson(d.type, d.counter ? intOf(v) : v);
    case 'link': return v ? keyToSql(model, d.target, v) : null;
    case 'embedded':
      return d.many ? Array.from(v, (e) => embeddedToJson(model, d.target, e)) : embeddedToJson(model, d.target, v);
    case 'list': return Array.from(v, (e) => toJson(model, d.elem, e));
    case 'json': return collectionToJson(model, d, v);
    default: throw new Error(`cannot encode ${d.kind}`);
  }
}

export function collectionToJson(model, d, v) {
  if (d.ctype === 'mixed') return mixedToJson(model, v);
  if (d.ctype === 'dictionary') {
    const out = record();
    for (const [k, e] of dictEntries(v)) out[k] = toJson(model, d.elem, e);
    return out;
  }
  return Array.from(v, (e) => toJson(model, d.elem, e)); // set or list
}

/** Tagged JSON for mixed values: {t, v}. */
export function mixedToJson(model, v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'number') return { t: 'number', v: floatJson(v) };
  if (typeof v === 'bigint') return { t: 'int', v: v.toString() };
  if (typeof v === 'string') return { t: 'string', v };
  if (v instanceof Date) return { t: 'date', v: v.getTime() };
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { t: 'data', v: bytesOf(v).toString('base64') };
  if (v instanceof Decimal128) return { t: 'decimal128', v: v.toString() };
  if (v instanceof ObjectId) return { t: 'objectId', v: v.toHexString() };
  if (v instanceof UUID) return { t: 'uuid', v: v.toString() };
  if (v instanceof Realm.Object) {
    const c = classOf(v);
    return { t: 'link', c, v: keyToSql(model, c, v) };
  }
  if (v instanceof Realm.Dictionary) {
    const out = record();
    for (const [k, e] of dictEntries(v)) out[k] = mixedToJson(model, e);
    return { t: 'dictionary', v: out };
  }
  if (v instanceof Realm.List || Array.isArray(v)) return { t: 'list', v: Array.from(v, (e) => mixedToJson(model, e)) };
  if (typeof v === 'object' && 'value' in v) return { t: 'int', v: v.value }; // Counter
  throw new TypeError(`unsupported mixed value: ${Object.prototype.toString.call(v)}`);
}
