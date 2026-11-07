// Translate a subset of the SDK query language (RQL) to SQL over the schema
// produced by convert.mjs. The goal is the same result set as the SDK,
// including its documented quirks (see README).

import { q } from './model.mjs';

export class RqlError extends Error {}
export class Unsupported extends RqlError {}

// ---------- tokenizer ----------

// The lexer follows the SDK's (realm 20.2), as measured with test/regressions.test.mjs:
// - whitespace is space, tab, CR and LF only (a no-break space is part of a name);
// - a name starts with a letter, "_", "$" or any non-ASCII character, and goes
//   on with those, digits and "-" (`prénom`, `prix$`, `x-1` are names);
// - keywords in any case, except NOT ANY SOME ALL NONE IN TRUE FALSE, which are
//   keywords only in upper or lower case (`Not`, `In`, `tRUE` are names);
// - some keywords are names too where a name is expected (`sort == 1`, `l.in`);
// - strings keep their escapes as typed ("a\nb" is a, \, n, b); only \" \' \/ \0
//   \\ \b \f \n \r \t and \uXXXX are accepted;
// - integers are read like C's strtoll with base 0: a leading 0 is octal and
//   stops at the first 8 or 9 (010 is 8, 08 is 0, 019 is 1), 0x is hex (no
//   sign), and values beyond 64 bits saturate. A fraction or an exponent makes
//   a decimal float (010.5 is 10.5, 010e0 is 10). LIMIT takes digits only.
const KW_ANY_CASE = new Set(['AND', 'OR', 'TRUEPREDICATE', 'FALSEPREDICATE', 'NULL', 'NIL', 'BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE', 'BETWEEN',
  'SORT', 'LIMIT', 'DISTINCT', 'ASC', 'ASCENDING', 'DESC', 'DESCENDING', 'SUBQUERY', 'GEOWITHIN', 'GEOBOX', 'GEOCIRCLE', 'GEOPOLYGON', 'OBJ']);
const KW_UPPER_OR_LOWER = new Set(['NOT', 'ANY', 'SOME', 'ALL', 'NONE', 'IN', 'TRUE', 'FALSE']);
const KW_NAMES = new Set(['IN', 'BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE', 'BETWEEN', 'SORT', 'LIMIT', 'DISTINCT', 'ASC', 'ASCENDING', 'DESC', 'DESCENDING']);
const WORD = /^[A-Za-z_$\u0080-￿][A-Za-z0-9_$\-\u0080-￿]*/;
const WORD_CHAR = /[A-Za-z0-9_$\-\u0080-￿]/;
const ESCAPES = '"\'/0\\bfnrt';

function keyword(w) {
  if (!/^[A-Za-z]+$/.test(w)) return null;
  const up = w.toUpperCase();
  if (KW_UPPER_OR_LOWER.has(up)) return w === up || w === w.toLowerCase() ? up : null;
  return KW_ANY_CASE.has(up) ? up : null;
}

const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);

/** Value of an integer literal as the SDK reads it (strtoll, base 0). */
export function intLiteral(raw) {
  let s = raw;
  const neg = s[0] === '-';
  if (s[0] === '-' || s[0] === '+') s = s.slice(1);
  let v;
  if (/^0[xX]/.test(s)) v = BigInt(s);
  else if (s.length > 1 && s[0] === '0') {
    const oct = /^[0-7]*/.exec(s.slice(1))[0];
    v = oct ? BigInt('0o' + oct) : 0n;
  } else v = BigInt(s);
  if (neg) v = -v;
  if (v > I64_MAX) v = I64_MAX;
  if (v < I64_MIN) v = I64_MIN;
  // A number, rounded beyond 2^53 like the ints the JS SDK reads (and the
  // converter stores): see README, Known limits.
  return Number(v);
}

// Literals of the SDK grammar that the translator does not read (the SDK
// accepts them, measured): typed literals, and float literals with an `f`
// suffix. They raise Unsupported, so that a caller falls back to the SDK.
const TYPED_LITERALS = [
  [/^(?:oid|uuid)\(/, 'an oid(...) or uuid(...) literal'],
  [/^T-?\d+:-?\d+/, 'a T<seconds>:<nanoseconds> date literal'],
  [/^-?\d{1,4}-\d{1,2}-\d{1,2}[@T]\d/, 'a YYYY-MM-DD@HH:MM:SS date literal'],
  [/^B64"/, 'a B64"..." literal'],
];
// Subscripts of the SDK grammar ([FIRST], [LAST], [SIZE], [n], ['key']).
const SUBSCRIPT = /^\[\s*(?:FIRST|LAST|SIZE|\d+|'[^']*'|"[^"]*"|\*)\s*\]/i;

function tokenize(src) {
  const toks = [];
  let i = 0;
  const valueEnd = () => {
    const t = toks[toks.length - 1];
    return t && (t.k === 'num' || t.k === 'str' || t.k === 'id' || t.k === 'arg' || (t.k === 'p' && (t.v === ')' || t.v === '}')));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] !== '\\') { j++; continue; }
        const e = src[j + 1];
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) j += 6;
        else if (e !== undefined && ESCAPES.includes(e)) j += 2;
        else throw new RqlError(`invalid escape "\\${e ?? ''}" in a string at ${j} (the SDK accepts \\" \\' \\/ \\0 \\\\ \\b \\f \\n \\r \\t \\uXXXX, kept as typed)`);
      }
      if (src[j] !== c) throw new RqlError('unterminated string');
      toks.push({ k: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const rest = src.slice(i);
    for (const [re, what] of TYPED_LITERALS) {
      if (re.test(rest)) throw new Unsupported(`${what} (use a $n argument)`);
    }
    // As in the SDK lexer, nan, inf and infinity in any case, with an optional
    // sign, are number constants and never property names (not even after a dot);
    // a longer name (`nané`, `inf$x`) is a name.
    const special = /^[+-]?(?:nan|inf(?:inity)?)/i.exec(rest);
    if (special && !WORD_CHAR.test(src[i + special[0].length] ?? '') && ((c !== '-' && c !== '+') || !valueEnd())) {
      const w = special[0];
      const body = w.replace(/^[+-]/, '').toLowerCase();
      toks.push({ k: 'num', v: body === 'nan' ? NaN : w[0] === '-' ? -Infinity : Infinity, raw: w, special: true });
      i += w.length;
      continue;
    }
    const hex = /^0[xX][0-9a-fA-F]+/.exec(rest);
    if (hex && !WORD_CHAR.test(src[i + hex[0].length] ?? '')) {
      toks.push({ k: 'num', v: intLiteral(hex[0]), raw: hex[0], int: true });
      i += hex[0].length;
      continue;
    }
    const num = /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num && ((c !== '-' && c !== '+') || !valueEnd())) {
      // `1.5f`, `1f`: a float literal in the SDK (lower-case f only; `1.5F` is an error there too).
      if (src[i + num[0].length] === 'f' && !WORD_CHAR.test(src[i + num[0].length + 1] ?? '')) throw new Unsupported(`the float literal ${num[0]}f (use ${num[0]} or a $n argument)`);
      const int = /^[+-]?\d+$/.test(num[0]);
      toks.push({ k: 'num', v: int ? intLiteral(num[0]) : Number(num[0]), raw: num[0], int });
      i += num[0].length;
      continue;
    }
    const arg = /^\$(\d+)/.exec(rest);
    if (arg && !WORD_CHAR.test(src[i + arg[0].length] ?? '')) {
      toks.push({ k: 'arg', v: Number(arg[1]) });
      i += arg[0].length;
      continue;
    }
    const agg = /^@[a-z]+/.exec(rest);
    if (agg) {
      toks.push({ k: 'agg', v: agg[0] === '@count' ? '@size' : agg[0], raw: agg[0] }); // the SDK reads @count as @size
      i += agg[0].length;
      continue;
    }
    const word = WORD.exec(rest);
    if (word) {
      const w = word[0];
      i += w.length;
      const kw = keyword(w);
      if (kw) toks.push({ k: 'kw', v: kw, raw: w });
      else if (/^O\d+$/.test(w)) throw new Unsupported(`${w} is an object key literal in the SDK`);
      else toks.push({ k: 'id', v: w });
      continue;
    }
    if (c === '[') {
      if (rest.startsWith('[c]')) { toks.push({ k: 'mod', v: 'c' }); i += 3; continue; }
      if (SUBSCRIPT.test(rest)) throw new Unsupported(`the subscript ${SUBSCRIPT.exec(rest)[0]}`);
      throw new RqlError(`unknown modifier at ${i}: the SDK accepts only [c] (in lower case)`);
    }
    const p = /^(==|!=|<>|<=|=<|>=|=>|&&|\|\||=|<|>|!|\(|\)|\{|\}|,|\.)/.exec(rest);
    if (p) { toks.push({ k: 'p', v: p[0] }); i += p[0].length; continue; }
    throw new RqlError(`unexpected character "${c}" at ${i}`);
  }
  toks.push({ k: 'eof' });
  return toks;
}

// ---------- parser ----------

const CMP = { '==': '==', '=': '==', '!=': '!=', '<>': '!=', '<': '<', '<=': '<=', '=<': '<=', '>': '>', '>=': '>=', '=>': '>=' };
const FLIP = { '==': '==', '!=': '!=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

export function parse(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const isKw = (v) => t[i].k === 'kw' && t[i].v === v;
  const isP = (v) => t[i].k === 'p' && t[i].v === v;
  const expectP = (v) => { if (!isP(v)) throw new RqlError(`expected "${v}"`); i++; };
  // A property name: a name, or a keyword that the SDK also reads as a name.
  const isName = () => t[i].k === 'id' || (t[i].k === 'kw' && KW_NAMES.has(t[i].v));
  const nameText = () => (t[i].k === 'id' ? t[i].v : t[i].raw);

  function operand() {
    const tok = peek();
    if (tok.k === 'num') { i++; return { t: 'lit', v: tok.v, int: !!tok.int, special: !!tok.special }; }
    if (tok.k === 'str') { i++; return { t: 'lit', v: tok.v }; }
    if (tok.k === 'arg') { i++; return { t: 'arg', i: tok.v }; }
    if (tok.k === 'kw' && (tok.v === 'TRUE' || tok.v === 'FALSE')) { i++; return { t: 'lit', v: tok.v === 'TRUE' }; }
    if (tok.k === 'kw' && (tok.v === 'NULL' || tok.v === 'NIL')) { i++; return { t: 'lit', v: null }; }
    if (isP('{')) {
      i++;
      const items = [];
      while (!isP('}')) {
        const o = operand();
        if (o.t !== 'lit' && o.t !== 'arg') throw new RqlError('list literal accepts values only');
        items.push(o);
        if (!isP(',')) break;
        i++;
        if (isP('}')) throw new RqlError('a value is needed after "," in {...} (the SDK refuses a trailing comma too)');
      }
      expectP('}');
      return { t: 'list', items };
    }
    if (isName()) {
      const segs = [nameText()];
      i++;
      let agg = null;
      while (isP('.')) {
        i++;
        if (peek().k === 'agg') {
          agg = peek().v;
          i++;
          break;
        }
        if (!isName()) throw new RqlError('expected property name after "."');
        segs.push(nameText());
        i++;
      }
      if (agg && agg !== '@size') throw new Unsupported(`${agg} is not supported`);
      if (isP('.')) throw new Unsupported(`operator inside key path: ${segs.join('.')}`);
      return { t: 'path', segs, agg };
    }
    // Measured: the SDK refuses @count / @size first in a key path (syntax
    // error), and accepts @links there (`@links.Person.friends.@count`).
    if (tok.k === 'agg') {
      if (tok.v === '@size') throw new RqlError(`${tok.raw} needs a key path before it`);
      throw new Unsupported(`${tok.raw} first in a key path`);
    }
    if (tok.k === 'kw' && ['SUBQUERY', 'GEOWITHIN', 'GEOBOX', 'GEOCIRCLE', 'GEOPOLYGON', 'OBJ'].includes(tok.v)) throw new Unsupported(tok.raw);
    throw new RqlError(`unexpected token ${tok.raw ?? tok.v ?? tok.k}`);
  }

  function comparison() {
    let quant = null;
    if (['ANY', 'SOME', 'ALL', 'NONE'].some(isKw)) { quant = peek().v === 'SOME' ? 'ANY' : peek().v; i++; }
    let left = operand();
    if (quant && left.t !== 'path') throw new RqlError(`${quant} needs a key path after it`);
    let op;
    const tok = peek();
    if (tok.k === 'p' && CMP[tok.v]) { op = CMP[tok.v]; i++; }
    else if (tok.k === 'kw' && ['BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE', 'IN'].includes(tok.v)) { op = tok.v; i++; }
    else if (tok.k === 'kw' && tok.v === 'BETWEEN') throw new Unsupported('BETWEEN');
    else throw new RqlError(`expected an operator, got ${tok.raw ?? tok.v ?? tok.k}`);
    let ci = false;
    if (peek().k === 'mod') {
      if (['<', '<=', '>', '>='].includes(op)) throw new RqlError(`[c] after ${tok.v} (the SDK refuses it too: syntax error)`);
      ci = true;
      i++;
    }
    // "x == ANY {a, b}" (or SOME, or an array argument "== ANY $0") is
    // "x IN {a, b}" with the element test, on a list too. Other operators, and
    // ALL or NONE, before a list are not translated.
    let anyList = false;
    if (['ANY', 'SOME', 'ALL', 'NONE'].some(isKw)) {
      if ((t[i + 1].k === 'p' && t[i + 1].v === '{') || t[i + 1].k === 'arg') {
        if (op !== '==' || !(isKw('ANY') || isKw('SOME'))) throw new Unsupported(`${tok.raw ?? tok.v} ${peek().raw} before a list`);
        i++;
        op = 'IN';
        anyList = true;
      } else {
        // Measured: the SDK accepts "i == ANY il" (a quantifier before a key path).
        throw new Unsupported(`${tok.raw ?? tok.v} ${peek().raw} before a key path`);
      }
    }
    let right = operand();
    if (op === 'IN' && right.t === 'arg') right = { t: 'argList', i: right.i };
    // The SDK reads "x == {a, b}" as ANY (x == a OR x == b) on a property, and
    // compares the whole list on a list; with != and an empty list it is false.
    // Only IN {...} and == ANY {...} are translated.
    if (left.t === 'list') throw new Unsupported('a {list} on the left of an operator');
    if (right.t === 'list' && op !== 'IN') throw new Unsupported(`a {list} after ${tok.raw ?? tok.v} (only IN {...} and == ANY {...} are translated)`);
    let flipped = false;
    if (left.t !== 'path' && right.t === 'path') {
      if (!FLIP[op]) throw new Unsupported(`value on the left of ${op}`);
      [left, right] = [right, left];
      op = FLIP[op];
      flipped = true;
    }
    if (left.t !== 'path') throw new RqlError(left.special || right.special || right.t !== 'path' ? 'cannot compare two constants' : 'comparison needs a key path');
    if (op === 'IN' && right.t !== 'list' && right.t !== 'argList') throw new Unsupported('IN needs a {list} or a list argument');
    return { t: 'cmp', quant, left, op, right, ci, flipped, anyList };
  }

  function atom() {
    if (isP('(')) { i++; const e = or(); expectP(')'); return e; }
    if (isKw('TRUEPREDICATE')) { i++; return { t: 'const', v: true }; }
    if (isKw('FALSEPREDICATE')) { i++; return { t: 'const', v: false }; }
    return comparison();
  }
  function not() {
    if (isKw('NOT') || isP('!')) { i++; return { t: 'not', e: not() }; }
    return atom();
  }
  function and() {
    const items = [not()];
    while (isKw('AND') || isP('&&')) { i++; items.push(not()); }
    return items.length === 1 ? items[0] : { t: 'and', items };
  }
  function or() {
    const items = [and()];
    while (isKw('OR') || isP('||')) { i++; items.push(and()); }
    return items.length === 1 ? items[0] : { t: 'or', items };
  }

  const where = or();
  // SORT and LIMIT apply in the order written, as in the SDK: a later SORT
  // takes precedence (an earlier one only orders its ties), and several LIMITs
  // keep the smallest. A SORT after a LIMIT sorts the first objects in
  // insertion order, which SQLite does not keep: not supported.
  let sort = [];
  let limit = null;
  while (peek().k === 'kw') {
    if (isKw('SORT')) {
      i++;
      if (limit !== null) throw new Unsupported('SORT after LIMIT (the SDK sorts the first objects in insertion order, which the SQLite file does not keep)');
      expectP('(');
      const keys = [];
      for (;;) {
        const p = operand();
        if (p.t !== 'path' || p.agg) throw new RqlError('SORT needs key paths');
        let desc = false;
        if (['ASC', 'ASCENDING'].some(isKw)) i++;
        else if (['DESC', 'DESCENDING'].some(isKw)) { desc = true; i++; }
        else throw new RqlError('SORT needs ASC or DESC');
        keys.push({ path: p, desc });
        if (isP(',')) { i++; continue; }
        break;
      }
      expectP(')');
      sort = [...keys, ...sort];
    } else if (isKw('LIMIT')) {
      i++;
      expectP('(');
      const n = peek();
      // As in the SDK: digits only (no sign, no hex, no fraction), 010 is 8.
      if (n.k !== 'num' || !/^\d+$/.test(n.raw)) throw new RqlError('LIMIT needs a non-negative integer, in digits');
      i++;
      expectP(')');
      const v = Math.min(n.v, Number.MAX_SAFE_INTEGER);
      limit = limit === null ? v : Math.min(limit, v);
    } else if (isKw('DISTINCT')) {
      throw new Unsupported('DISTINCT');
    } else break;
  }
  if (peek().k !== 'eof') throw new RqlError(`unexpected token ${peek().raw ?? peek().v}`);
  return { where, sort, limit };
}

// ---------- case folding ----------

// The SDK folds ASCII and the Latin-1 block U+00C0..U+00DE (except ×) only.
const LATIN1_UPPER = [];
for (let c = 0xc0; c <= 0xde; c++) if (c !== 0xd7) LATIN1_UPPER.push(c);

export function foldJs(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x41 && c <= 0x5a) out += String.fromCharCode(c + 32);
    else if (c >= 0xc0 && c <= 0xde && c !== 0xd7) out += String.fromCharCode(c + 32);
    else out += ch;
  }
  return out;
}

function foldSql(expr) {
  let e = expr;
  for (const c of LATIN1_UPPER) e = `replace(${e},'${String.fromCharCode(c)}','${String.fromCharCode(c + 32)}')`;
  return `lower(${e})`; // SQLite lower() without ICU folds ASCII only
}

// ---------- compiler ----------

// The JS SDK 20.2 converts a Date before 1970 that has a millisecond part
// with floor(seconds) and a negative remainder: Date(-1) is stored as -1001 ms.
// Query arguments go through the same conversion, so we apply it too.
export const sdkDateMs = (ms) => (ms < 0 && ms % 1000 !== 0 ? Math.floor(ms / 1000) * 1000 + (ms % 1000) : ms);

// SDK objects are recognised by their methods. A stored property with the same
// name (`_objectKey`, `objectSchema`) is an accessor on the class prototype that
// hides the method, so look for a method (data property) along the prototype
// chain instead of reading v._objectKey. This keeps realm out of the translator.
function sdkMethod(v, name) {
  for (let o = v; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d && typeof d.value === 'function') return d.value;
  }
  return null;
}
const isSdkObject = (v) => v !== null && typeof v === 'object' && !!sdkMethod(v, 'objectSchema') && !!sdkMethod(v, '_objectKey');

// Class name of an SDK object as the SDK reads it (constructor.name), without
// calling objectSchema(), which reads this.constructor itself. A stored
// property named "constructor" replaces it on the class prototype; the SDK then
// fails on such an argument too ("Expected an object schema name...").
function sdkClassName(v) {
  for (let o = Object.getPrototypeOf(v); o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, 'constructor');
    if (!d) continue;
    if (typeof d.value === 'function') return d.value.name;
    break;
  }
  throw new RqlError('an object whose class has a stored property named "constructor" cannot be a query argument (the SDK fails on it too)');
}

// Property lookup that ignores Object.prototype members (toString, valueOf...).
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

const TEXT_OPS = new Set(['BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE']);

// Kind of a value compared with a property (literal or $n argument).
function kindOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'bigint') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  if (isSdkObject(v)) return 'object';
  switch (v._bsontype) {
    case 'ObjectID': case 'ObjectId': return 'objectId';
    case 'Decimal128': return 'decimal';
    case 'UUID': return 'uuid';
    case 'Binary': return v.sub_type === 4 ? 'uuid' : 'data';
    default:
  }
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return 'data';
  return v?.constructor?.name ?? typeof v;
}

// Value kinds the SDK accepts for each property type (measured; anything else
// is an error in the SDK too). A string compared with a number property is
// converted by the SDK in ways not reproduced here (Unsupported).
const NUMERIC = new Set(['int', 'double', 'float', 'decimal128']);
const ACCEPTS = {
  int: ['number', 'decimal'], double: ['number', 'decimal'], float: ['number', 'decimal'], decimal128: ['number', 'decimal'],
  bool: ['bool'], string: ['string'], date: ['date'], objectId: ['objectId'], uuid: ['uuid'], data: ['data'], link: ['object'],
};

/**
 * A Decimal128 argument as a number, for comparisons with int, double and
 * float properties. The SDK converts it to a double for doubles and floats, and
 * compares it exactly with ints: refused when the double would not give the
 * same answer (an integer above 2^53).
 */
function decimalNumber(d, type) {
  const s = d.toString();
  const n = Number(s);
  // Measured: a Decimal128 NaN is not compared like a double NaN ("d > $0" matches every number).
  if (Number.isNaN(n)) throw new Unsupported('Decimal128 NaN as a query argument');
  if (type !== 'int') return n;
  if (!Number.isFinite(n)) throw new Unsupported(`Decimal128 ${s} compared with an int`);
  // s is <digits>[.<digits>][E<exp>]: is its exact value an integer?
  const m = /^[+-]?(\d*)(?:\.(\d*))?(?:E([+-]?\d+))?$/i.exec(s);
  if (!m) throw new Unsupported(`Decimal128 ${s} compared with an int`);
  const digits = m[1] + (m[2] ?? '');
  const shift = (m[2] ?? '').length - Number(m[3] ?? 0); // value = digits / 10^shift
  const integer = shift <= 0 || /^0*$/.test(digits.slice(Math.max(0, digits.length - shift)));
  // An integer must be exact as a double; a non-integer must not round to one.
  if (integer ? !Number.isSafeInteger(n) : Number.isInteger(n)) throw new Unsupported(`Decimal128 ${s} compared with an int: not exact as a double`);
  return n;
}

/**
 * @param {string|object} query RQL text (or parsed AST)
 * @param {{model, className, args?, quirks?, select?}} opts
 *   quirks (default true): reproduce SDK 20.2 behaviours that look like bugs (see README).
 * @returns {{sql, params, warnings, sorted, limit}}
 */
export function translate(query, { model, className, args = [], quirks = true, select } = {}) {
  if (!model?.classes || typeof className !== 'string' || !Object.hasOwn(model.classes, className)) throw new RqlError(`unknown class ${className}`);
  const ast = typeof query === 'string' ? parse(query) : query;
  const params = [];
  const warnings = [];
  const outerJoins = [];
  const joinIndex = new Map();
  let n = 0;
  const alias = () => `t${++n}`;
  const base = model.classes[className];
  const keyCol = (t) => q(t.key.synthetic ? '_rid' : t.key.column);
  const P = (v) => { params.push(v); return '?'; };

  const argValue = (i) => {
    if (i >= args.length) throw new RqlError(`missing argument $${i}`);
    return args[i];
  };

  /**
   * A property of a class (or embedded class) by its stored name, or by the
   * app's public name (mapTo), which the model records when it was built with
   * --schema; the SDK accepts both. Returns [stored name, description].
   * A name the model does not know: RqlError when the model has the app schema
   * (the SDK refuses it too); without it, Unsupported, because the name can be
   * a backlink or a public name of the app, which only the app schema declares.
   */
  function prop(owner, label, s) {
    let d = own(owner.props, s);
    if (d) return [s, d];
    const stored = owner.aliases ? own(owner.aliases, s) : undefined;
    d = typeof stored === 'string' ? own(owner.props, stored) : undefined;
    if (d) return [stored, d];
    if (owner.skipped && Object.hasOwn(owner.skipped, s)) throw new Unsupported(`${label}.${s} is not converted (${owner.skipped[s]})`);
    if (!model.appSchema) throw new Unsupported(`unknown property ${label}.${s}: not in the file (the model was built without --schema, so it does not know the backlinks and public mapTo names of the app)`);
    throw new RqlError(`unknown property ${label}.${s}`);
  }

  /**
   * `soft`: an element of an array argument, or a literal inside {...}. The SDK
   * refuses a value of the wrong type alone (`s == 5`, `s == $0` with 5, `$0`
   * inside {...}) but not there: it matches nothing, or converts it
   * (`b == $0` with [1] matched every object). Not reproduced: Unsupported,
   * except on a link, where the SDK refuses it there too (measured).
   */
  function toSql(leaf, v, soft = false) {
    if (v === null || v === undefined) return null;
    const kind = kindOf(v);
    if (leaf.type === 'embedded') {
      // Measured: the SDK refuses every value but null for an embedded object.
      throw new RqlError(kind === 'object' ? `an object cannot be compared with the embedded object ${leaf.emb} (the SDK refuses it too)` : `cannot compare the embedded object ${leaf.emb} with a ${kind} value (the SDK refuses it too)`);
    }
    const ok = ACCEPTS[leaf.type];
    if (ok && !ok.includes(kind)) {
      if (kind === 'string' && NUMERIC.has(leaf.type)) throw new Unsupported(`a string compared with a ${leaf.type} property (the SDK converts it to a number)`);
      // Measured: the SDK answers an array argument inside {...} ("tags IN {$0}").
      if (kind === 'array') throw new Unsupported('an array argument here (inside {...})');
      if (soft && leaf.type !== 'link') throw new Unsupported(`a ${kind} value in an array argument or a {list} compared with a ${leaf.type} property (the SDK matches nothing or converts it)`);
      throw new RqlError(`cannot compare a ${leaf.type} property with a ${kind} value (the SDK refuses it too)`);
    }
    if (kind === 'object') {
      const name = sdkClassName(v);
      if (name !== leaf.target) throw new RqlError(`a link to ${leaf.target} cannot be compared with an object of class ${name}`);
      const t = model.classes[name];
      return t.key.synthetic ? Number(sdkMethod(v, '_objectKey').call(v)) : toSql({ type: t.key.type }, v[t.key.column]);
    }
    // Comparisons on data are valid in the SDK and not translated.
    if (kind === 'data') throw new Unsupported('comparison on data');
    if (kind === 'decimal') return decimalNumber(v, leaf.type);
    if (kind === 'date') return quirks ? sdkDateMs(v.getTime()) : v.getTime();
    if (kind === 'bool') return v ? 1 : 0;
    if (kind === 'objectId') return v.toHexString();
    if (kind === 'uuid') return v.toString();
    if (kind === 'array' || kind === 'data' || (typeof v === 'object' && kind !== 'number')) throw new RqlError(`a ${kind} value cannot be compared here`);
    return v;
  }

  /**
   * Walk a key path from the base class. Collections open "levels" (one per
   * list, backlink or embedded list); to-one links are LEFT JOINs outside any
   * level and inner JOINs inside one (the SDK drops null links there). Inside a
   * level, a to-one link at the end of the path drops the element too when it
   * is null (measured: "friends.boss != $0" and "ALL friends.boss == boss" skip
   * the friends without a boss).
   */
  function walk(segs, { forSort = false } = {}) {
    let cls = base;
    let a = 'b';
    const levels = [];
    let guard = null; // expression that is NULL when a to-one hop is missing (for SORT)
    let json = null; // inside an embedded object: {expr, path, emb}
    let toOne = false; // the path goes through a to-one link or an embedded object
    const cur = () => levels[levels.length - 1];
    // kind: 'links' (list of objects), 'backlinks', 'values' (list of values), 'embedded' (list of embedded objects)
    const level = (first, corr, pos, kind) => {
      if (forSort) throw new RqlError('cannot sort on a list');
      levels.push({ first, corr, joins: [], conds: [], pos, kind });
    };
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      const last = k === segs.length - 1;
      if (json) {
        const [name, d] = prop(model.embedded[json.emb], json.emb, s);
        const path = `${json.path}.${JSON.stringify(name)}`;
        if (d.kind === 'scalar') {
          if (!last) throw new RqlError(`${s} is not a link`);
          if (!['int', 'string', 'bool'].includes(d.type)) throw new Unsupported(`embedded ${d.type} field in a query`);
          return { leaf: { sql: `json_extract(${json.expr}, '${path}')`, type: d.type }, levels, guard, toOne };
        }
        if (d.kind === 'embedded' && !d.many) {
          toOne = true;
          json = { ...json, path, emb: d.target };
          // A null embedded object: through links it reads as null (SORT puts
          // it after the values); inside a list it drops the element, as a
          // null link does.
          if (levels.length) cur().conds.push(`json_extract(${json.expr}, '${path}') IS NOT NULL`);
          else guard = `json_extract(${json.expr}, '${path}')`;
          if (last) return { leaf: { sql: `json_extract(${json.expr}, '${path}')`, type: 'embedded', emb: d.target }, levels, guard, toOne };
          continue;
        }
        throw new Unsupported(`embedded ${d.kind} in a key path`);
      }
      const [name, d] = prop(cls, cls.name, s);
      if (d.kind === 'scalar') {
        if (!last) throw new RqlError(`${cls.name}.${s} is not a link`);
        const direct = k === 0;
        return { leaf: { sql: `${a}.${q(d.column)}`, special: d.special ? `${a}.${q(d.special)}` : null, type: d.type, direct }, levels, guard, toOne };
      }
      if (d.kind === 'link') {
        if (!last) toOne = true;
        if (levels.length) cur().toOne = true;
        if (last) {
          if (levels.length) cur().conds.push(`${a}.${q(d.column)} IS NOT NULL`);
          return { leaf: { sql: `${a}.${q(d.column)}`, type: 'link', target: d.target }, levels, guard, toOne };
        }
        const target = model.classes[d.target];
        const x = alias();
        if (levels.length) {
          cur().joins.push(`JOIN ${q(target.table)} ${x} ON ${x}.${keyCol(target)} = ${a}.${q(d.column)}`);
        } else {
          const jk = `${a}.${name}`;
          const known = joinIndex.get(jk);
          if (known) { a = known; cls = target; guard = `${a}.${keyCol(target)}`; n--; continue; }
          joinIndex.set(jk, x);
          outerJoins.push(`LEFT JOIN ${q(target.table)} ${x} ON ${x}.${keyCol(target)} = ${a}.${q(d.column)}`);
          guard = `${x}.${keyCol(target)}`;
        }
        a = x;
        cls = target;
        continue;
      }
      if (d.kind === 'embedded') {
        let j;
        if (d.many) {
          j = alias();
          level(`json_each(${a}.${q(d.column)}) ${j}`, null, `${j}.key`, 'embedded');
          json = { expr: `${j}.value`, path: '$', emb: d.target };
        } else {
          toOne = true;
          json = { expr: `${a}.${q(d.column)}`, path: '$', emb: d.target };
          if (!levels.length) guard = json.expr;
          else cur().conds.push(`${json.expr} IS NOT NULL`); // see above
        }
        if (last) {
          if (d.many) return { leaf: { sql: `${j}.value`, type: 'embedded list', emb: d.target }, levels, guard, toOne, collection: true };
          return { leaf: { sql: json.expr, type: 'embedded', emb: d.target }, levels, guard, toOne };
        }
        continue;
      }
      if (d.kind === 'list') {
        const l = alias();
        level(`${q(d.table)} ${l}`, `${l}."owner" = ${a}.${keyCol(cls)}`, `${l}."pos"`, d.elem.type === 'object' ? 'links' : 'values');
        if (d.elem.type !== 'object') {
          if (!last) throw new RqlError(`${cls.name}.${s} is a list of values`);
          return { leaf: { sql: `${l}."value"`, special: d.elem.special ? `${l}.${q(d.elem.special)}` : null, type: d.elem.type, inList: true }, levels, guard, toOne, collection: true };
        }
        if (last) return { leaf: { sql: `${l}."target"`, type: 'link', target: d.elem.target }, levels, guard, toOne, collection: true };
        const target = model.classes[d.elem.target];
        const x = alias();
        cur().joins.push(`JOIN ${q(target.table)} ${x} ON ${x}.${keyCol(target)} = ${l}."target"`);
        a = x;
        cls = target;
        continue;
      }
      if (d.kind === 'backlink') {
        const src = model.classes[d.source];
        const v = alias();
        level(`${q(d.view)} ${v}`, `${v}."owner" = ${a}.${keyCol(cls)}`, null, 'backlinks');
        if (last) return { leaf: { sql: `${v}."source"`, type: 'link', target: src.name, backlink: true }, levels, guard, toOne, collection: true };
        const x = alias();
        cur().joins.push(`JOIN ${q(src.table)} ${x} ON ${x}.${keyCol(src)} = ${v}."source"`);
        a = x;
        cls = src;
        continue;
      }
      throw new Unsupported(`${d.ctype ?? d.kind} property ${cls.name}.${s} in a query`);
    }
    throw new RqlError('empty key path');
  }

  // SELECT 1 FROM <levels> WHERE <correlation> AND <conditions> AND <extra>
  function subquery(levels, extra) {
    let from = `${levels[0].first}${levels[0].joins.length ? ' ' + levels[0].joins.join(' ') : ''}`;
    for (const L of levels.slice(1)) from += ` JOIN ${L.first} ON ${L.corr ?? '1'}${L.joins.length ? ' ' + L.joins.join(' ') : ''}`;
    const where = [levels[0].corr, ...levels.flatMap((L) => L.conds), extra].filter(Boolean);
    return `FROM ${from}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  }

  const blob = (e) => `CAST(${e} AS BLOB)`;
  // NULL test that knows about the NaN companion column.
  const isNull = (leaf) => (leaf.special ? `(${leaf.sql} IS NULL AND ${leaf.special} IS NULL)` : `${leaf.sql} IS NULL`);
  const isNaNSql = (leaf) => `IFNULL(${leaf.special} = 'NaN', 0)`;

  /**
   * Comparison with null, as observed in the SDK: <= and >= behave like ==,
   * < and > are false; LIKE null is "== null", CONTAINS null means "not null",
   * BEGINSWITH / ENDSWITH null are false. Quirk (quirks: true only): a string
   * property of the base class has null below every string, so >= null is
   * always true, > null is "not null" and CONTAINS, BEGINSWITH, ENDSWITH null
   * are always true.
   */
  function cmpNull(leaf, op) {
    if (TEXT_OPS.has(op) && leaf.type !== 'string') throw new RqlError(`${op} on ${leaf.type}`);
    const quirk = quirks && leaf.direct && leaf.type === 'string';
    switch (op) {
      case '==': case 'LIKE': return isNull(leaf);
      case '!=': return `NOT ${isNull(leaf)}`;
      case '<': return '0';
      case '>': return quirk ? `NOT ${isNull(leaf)}` : '0';
      case '<=': return isNull(leaf);
      case '>=': return quirk ? '1' : isNull(leaf);
      case 'CONTAINS': return quirk ? '1' : `NOT ${isNull(leaf)}`;
      case 'BEGINSWITH': case 'ENDSWITH': return quirk ? '1' : '0';
      default: throw new RqlError(`operator ${op}`);
    }
  }

  /**
   * Two-valued SQL (0/1, never NULL) comparing a leaf with one value.
   * intLiteral: an integer literal; literal: a literal (not a $n argument);
   * soft: an element of an array argument or a literal inside {...} (see toSql).
   */
  function cmpValue(leaf, op, raw, ci, { intLiteral = false, literal = false, soft = false } = {}) {
    // Measured: a string literal with a string operator on a link, bool, date,
    // objectId, uuid or embedded object ("b CONTAINS "x"", "l LIKE "*"") is
    // answered by the SDK (no rows in every case tried); a $n string is refused.
    if (TEXT_OPS.has(op) && literal && typeof raw === 'string' && !['string', 'data'].includes(leaf.type)) {
      throw new Unsupported(`a string literal with ${op} on a ${leaf.type} property (the SDK answers it)`);
    }
    let v = toSql(leaf, raw, soft);
    if (v === null) return cmpNull(leaf, op);
    const float = leaf.type === 'double' || leaf.type === 'float';
    if (!float && typeof v === 'number' && !Number.isFinite(v)) {
      // nan / inf constants and NaN / Infinity arguments, as measured on the SDK:
      // Infinity is an error except on doubles and floats; NaN is an error on
      // anything but numbers, and an int is never equal to NaN, never below it,
      // and above it unless it is null.
      if (!Number.isNaN(v)) throw new RqlError(`Infinity not supported for ${leaf.type}`);
      if (leaf.type !== 'int') throw new RqlError(`cannot compare nan with a ${leaf.type} property`);
      switch (op) {
        case '==': case '<': case '<=': return '0';
        case '!=': return '1';
        case '>': case '>=': return `(${leaf.sql} IS NOT NULL)`;
        default: throw new RqlError(`${op} on ${leaf.type}`);
      }
    }
    // Values compared with a float property are rounded to float first (1e-300 becomes 0).
    if (leaf.type === 'float' && typeof v === 'number') v = Math.fround(v);
    if (float && typeof v === 'number' && Number.isNaN(v)) {
      if (leaf.direct || !leaf.special) return op === '!=' ? '1' : '0'; // IEEE on base properties
      // Through links and in lists the SDK orders NaN below every number and
      // NaN == NaN; null (or a null link) is not above NaN.
      switch (op) {
        case '==': case '<=': return isNaNSql(leaf);
        case '!=': return `NOT ${isNaNSql(leaf)}`;
        case '<': return '0';
        case '>': return `(${leaf.sql} IS NOT NULL)`;
        case '>=': return `NOT ${isNull(leaf)}`;
      }
    }
    if (TEXT_OPS.has(op)) {
      if (leaf.type !== 'string') throw new RqlError(`${op} on ${leaf.type}`);
      if (typeof v !== 'string') throw new RqlError(`${op} needs a string`);
    }
    if (leaf.type === 'decimal128' || leaf.type === 'data') throw new Unsupported(`comparison on ${leaf.type}`);
    let x = leaf.sql;
    if (ci) {
      if (leaf.type !== 'string') throw new RqlError('[c] on a non-string property');
      x = foldSql(x);
      v = foldJs(v);
    }
    switch (op) {
      case '==': return `IFNULL(${x} = ${P(v)}, 0)`;
      case '!=': return `NOT IFNULL(${x} = ${P(v)}, 0)`;
      case '<': case '<=': case '>': case '>=': {
        // Measured: bools order false < true (nulls never match); links only take == and !=.
        if (leaf.type === 'link') throw new RqlError(`${op} on a link (the SDK accepts only == and !=)`);
        const base = `IFNULL(${x} ${op} ${P(v)}, 0)`;
        if (op === '<' || op === '<=') {
          // NaN sorts below numbers through links and in lists, and on base
          // properties compared with an integer literal.
          if (float && leaf.special && (!leaf.direct || (quirks && intLiteral))) return `(${isNaNSql(leaf)} OR ${base})`;
          // A null string on the base class is below every string.
          if (quirks && leaf.type === 'string' && leaf.direct) return `(${leaf.sql} IS NULL OR ${base})`;
        }
        return base;
      }
      // On the UTF-8 bytes (BLOB): SQLite's text functions stop at a NUL character.
      // An empty BLOB makes substr() NULL, so an empty prefix or suffix is "not null".
      case 'BEGINSWITH': return v === '' ? `(${x} IS NOT NULL)` : `IFNULL(substr(${blob(x)}, 1, length(${blob(P(v))})) = ${blob(P(v))}, 0)`;
      case 'ENDSWITH': return v === '' ? `(${x} IS NOT NULL)` : `IFNULL(substr(${blob(x)}, -length(${blob(P(v))})) = ${blob(P(v))}, 0)`;
      case 'CONTAINS': return `IFNULL(instr(${blob(x)}, ${blob(P(v))}) > 0, 0)`;
      case 'LIKE':
        // GLOB stops at a NUL character (a NUL in the value is a documented limit).
        if (v.includes('\0')) throw new Unsupported('LIKE with a NUL character in the pattern');
        return `IFNULL(${x} GLOB ${P(v.replace(/\[/g, '[[]'))}, 0)`;
      default: throw new RqlError(`operator ${op}`);
    }
  }

  /**
   * Measured: a link compared with an array argument (or "== ANY {…}") that
   * holds both null and objects gives SDK rows that are not "== null OR ==
   * object" ("l == $0" with [o, null] skipped some null links, with [null, o]
   * the object). IN with the same values works.
   */
  function mixedNullLinks(values) {
    if (values.some((x) => x == null) && values.some((x) => x != null)) {
      throw new Unsupported('a link compared with null and objects in one array argument or == ANY {...} (the SDK gives other rows)');
    }
  }

  /**
   * The values of `IN {…}` or `IN $n`: an array argument only, as in the SDK.
   * `soft`: a literal inside {...} or an element of the array (see toSql).
   */
  function inItems(right) {
    if (right.t === 'list') return right.items.map((it) => (it.t === 'arg' ? { v: argValue(it.i) } : { ...it, soft: true }));
    const a = argValue(right.i);
    if (!Array.isArray(a)) throw new RqlError(`IN $${right.i} needs an array argument (the SDK refuses ${kindOf(a)})`);
    return a.map((v) => ({ v, soft: true }));
  }

  /**
   * [c] with a value on a property that is not a string, as measured on the
   * SDK: IN ignores it (on a link it is an error); == and != ignore it on a
   * property of the base object (or a list of links there, with ANY or no
   * quantifier; ALL and NONE are refused) compared with a value that is not
   * null, and refuse it through a link, a list of values, an embedded object or
   * @count/@size, and with null (except on a link or an embedded object of the
   * base object).
   */
  function valueCi(leaf, node) {
    if (!node.ci || leaf.type === 'string') return node.ci;
    // Measured: "ALL friends ==[c] $0", "NONE fans ==[c] ANY {$0}" are refused
    // by the SDK; ANY (or no quantifier) is answered.
    if (leaf.type === 'link' && (node.quant === 'ALL' || node.quant === 'NONE')) throw new RqlError(`[c] on a list of links with ${node.quant} (the SDK refuses it too)`);
    if (node.op === 'IN') {
      if (leaf.type === 'link') {
        // "l ==[c] ANY {…}" follows the == rule (measured): [c] is ignored on
        // a link of the base object or a list of links there, refused through a link.
        if (!node.anyList) throw new RqlError('IN[c] on a link (the SDK refuses it too)');
        if (!node.base) throw new RqlError('[c] on a link reached through a link (the SDK refuses it too)');
      }
      return false;
    }
    if (TEXT_OPS.has(node.op)) return false; // refused in cmpValue: an operator on strings
    if (node.flipped) throw new Unsupported('[c] with the value on the left of a property that is not a string');
    if (!node.base) throw new RqlError(`[c] on a ${leaf.type} reached through a link, a list or an embedded object, or on @count/@size (the SDK refuses it too)`);
    const v = node.right.t === 'arg' ? argValue(node.right.i) : node.right.v;
    if (Array.isArray(v)) throw new Unsupported('[c] with an array argument on a property that is not a string');
    if (v === null || v === undefined) {
      if (leaf.type === 'decimal128') throw new Unsupported('[c] with null on a decimal128 property');
      if (leaf.type !== 'link' && leaf.type !== 'embedded' && leaf.type !== 'data') throw new RqlError(`[c] with null on a ${leaf.type} property (the SDK refuses it too)`);
    }
    return false; // a data or decimal128 value: Unsupported in cmpValue
  }

  const NUMBERS = new Set(['int', 'double', 'float', 'decimal128']);
  /**
   * Types of two key paths, as the SDK checks them (measured): the same type,
   * or two numbers; links with == and != only. A string operator or [c] needs a
   * string (or data) on the right. Comparisons the SDK accepts but that are not
   * reproduced here are Unsupported: data, decimal128, embedded objects, links
   * to two different classes (the SDK compares internal object keys), a string
   * operator with a property that is not a string on the left.
   */
  function checkPathTypes(a, b, op, ci) {
    if ([a.type, b.type].some((t) => t === 'embedded' || t === 'embedded list')) throw new Unsupported('comparing embedded objects');
    const refuse = () => new RqlError(`cannot compare a ${a.type} property with a ${b.type} property${ci ? ' with [c]' : ''}${TEXT_OPS.has(op) ? ` by ${op}` : ''} (the SDK refuses it too)`);
    if (TEXT_OPS.has(op)) {
      if (b.type !== 'string' && b.type !== 'data') throw refuse();
      if (a.type !== 'string' || b.type !== 'string') throw new Unsupported(`${op} between a ${a.type} property and a ${b.type} property`);
      return;
    }
    const same = a.type === b.type || (NUMBERS.has(a.type) && NUMBERS.has(b.type));
    if (!same || (ci && b.type !== 'string' && b.type !== 'data')) throw refuse();
    for (const t of [a.type, b.type]) if (t === 'decimal128' || t === 'data') throw new Unsupported(`comparing two key paths of type ${t}`);
    if (a.type === 'link') {
      if (op !== '==' && op !== '!=') throw new RqlError(`${op} on links (the SDK accepts only == and !=)`);
      if (a.target !== b.target) throw new Unsupported(`comparing a link to ${a.target} with a link to ${b.target} (the SDK compares internal object keys)`);
    }
  }

  function leafPredicate(leaf, node) {
    const { op, right } = node;
    // Measured: the SDK answers a data property with a string operator or IN and
    // a string (BEGINSWITH "ab", IN {"ab"}) in ways not reproduced; == "ab" is an error.
    if (leaf.type === 'data' && right.t !== 'path' && (TEXT_OPS.has(op) || op === 'IN')) throw new Unsupported(`${op} on a data property`);
    let ci = right.t === 'path' ? node.ci : valueCi(leaf, node);
    if (op === 'IN') {
      if (quirks && ci && leaf.direct) { ci = false; warnings.push('SDK quirk reproduced: [c] is ignored by IN on a base property.'); }
      let items = inItems(right);
      if (items.some((it) => kindOf(it.v) === 'decimal')) throw new Unsupported('Decimal128 in IN (the SDK does not match it with ints)');
      if (items.some((it) => kindOf(it.v) === 'array')) {
        // Measured: an array inside an array argument is refused by the SDK;
        // an array argument inside {...} ("age IN {$0}") is answered.
        if (right.t === 'list') throw new Unsupported('an array argument inside {...}');
        throw new RqlError('nested arrays are not supported as query arguments (the SDK refuses them too)');
      }
      // Measured: "l == ANY {null, $0}" gives SDK rows that are not "l == null OR l == $0".
      if (node.anyList && leaf.type === 'link') mixedNullLinks(items.map((it) => it.v));
      if (quirks && leaf.direct && (leaf.type === 'double' || leaf.type === 'float') && right.t === 'list') {
        // SDK 20.2: integer literals in IN on a float/double property never match,
        // and a list made only of integer literals matches every object.
        if (items.length && items.every((it) => it.int)) { warnings.push('SDK quirk reproduced: integer-only IN on a double matches all.'); return '1'; }
        items = items.filter((it) => !it.int);
      }
      if (!items.length) return '0';
      // The SDK gives unexplained results for nan in IN on an int ("i IN {nan}" matched -1).
      if (leaf.type === 'int' && items.some((it) => typeof it.v === 'number' && Number.isNaN(it.v))) throw new Unsupported('nan in IN {...} on an int property');
      return '(' + items.map((it) => cmpValue(leaf, '==', it.v, ci, { soft: !!it.soft })).join(' OR ') + ')';
    }
    if (right.t === 'path') {
      const r = walk(right.segs);
      if (r.levels.length || right.agg) throw new Unsupported('comparing two key paths through a list');
      checkPathTypes(leaf, r.leaf, op, ci);
      if (leaf.special || r.leaf.special) throw new Unsupported('comparing two double key paths');
      let x = leaf.sql, y = r.leaf.sql;
      if (ci) { x = foldSql(x); y = foldSql(y); }
      const bothNull = `(${x} IS NULL AND ${y} IS NULL)`;
      switch (op) {
        case 'BEGINSWITH': return `IFNULL(CASE WHEN length(${blob(y)}) = 0 THEN ${x} IS NOT NULL ELSE substr(${blob(x)}, 1, length(${blob(y)})) = ${blob(y)} END, 0)`;
        case 'ENDSWITH': return `IFNULL(CASE WHEN length(${blob(y)}) = 0 THEN ${x} IS NOT NULL ELSE substr(${blob(x)}, -length(${blob(y)})) = ${blob(y)} END, 0)`;
        // As in the SDK: a null right side is contained in every string.
        case 'CONTAINS': return `(IFNULL(instr(${blob(x)}, ${blob(y)}) > 0, 0) OR (${x} IS NOT NULL AND ${y} IS NULL))`;
        case 'LIKE': throw new Unsupported('LIKE between two key paths');
        case '==': return `(IFNULL(${x} = ${y}, 0) OR ${bothNull})`;
        case '!=': return `NOT (IFNULL(${x} = ${y}, 0) OR ${bothNull})`;
        // null <= null and null >= null are true in the SDK.
        case '<=': case '>=': return `(IFNULL(${x} ${op} ${y}, 0) OR ${bothNull})`;
        default: return `IFNULL(${x} ${op} ${y}, 0)`;
      }
    }
    if (right.t === 'arg') {
      const v = argValue(right.i);
      if (Array.isArray(v)) {
        // The SDK compares with each element: true when one of them matches.
        if (node.throughList) throw new Unsupported('an array argument on a key path through a list');
        if (v.some((e) => Array.isArray(e))) throw new RqlError('nested arrays are not supported as query arguments (the SDK refuses them too)');
        if (v.some((e) => kindOf(e) === 'decimal')) throw new Unsupported('Decimal128 inside an array argument');
        if (leaf.type === 'link') mixedNullLinks(v);
        // Quirk (measured): with an array argument, == ignores [c] on a string
        // property of the base object ("s ==[c] $0" with ["a"] does not match "A");
        // != keeps it, and so do key paths through a link or an embedded object.
        if (quirks && ci && op === '==' && leaf.direct && leaf.type === 'string') {
          ci = false;
          warnings.push('SDK quirk reproduced: [c] is ignored by == with an array argument on a base string property.');
        }
        return v.length ? '(' + v.map((e) => cmpValue(leaf, op, e, ci, { soft: true })).join(' OR ') + ')' : '0';
      }
      return cmpValue(leaf, op, v, ci);
    }
    return cmpValue(leaf, op, right.v, ci, { intLiteral: right.int, literal: true });
  }

  /**
   * @count / @size (the SDK reads both as @size). The count is taken on the
   * last collection of the key path, or the size in UTF-8 bytes of the string
   * at its end; lists before it are ANY: "friends.tags.@count == 2" is true when
   * one friend has 2 tags.
   */
  function compileCount(node, w, leaf) {
    const { levels, guard } = w;
    // Measured: the SDK answers "ALL friends.@count > 0", "NONE tags.@count == 0"...
    if (node.quant) throw new Unsupported(`${node.quant} with @count/@size`);
    const str = !w.collection && (leaf.type === 'string' || leaf.type === 'data');
    let countExpr;
    let outer;
    if (str) {
      countExpr = `length(CAST(${leaf.sql} AS BLOB))`; // bytes; NULL for a null string or a null link
      outer = levels;
    } else if (w.collection) {
      countExpr = `(SELECT count(*) ${subquery([levels[levels.length - 1]])})`;
      outer = levels.slice(0, -1);
    } else if (leaf.type === 'link' || leaf.type === 'embedded') {
      // Measured: the SDK answers @count on a to-one link or embedded object ("boss.@count == 1").
      throw new Unsupported(`@count/@size on a ${leaf.type === 'link' ? 'link' : 'embedded object'}`);
    } else throw new RqlError(`@size on a ${leaf.type} property (the SDK refuses it too)`);
    if (node.op === 'IN' && !node.anyList && (w.toOne || outer.length) && inItems(node.right).length !== 1) {
      // Measured: "l.items.@count IN {0, 3}" and "friends.tags.@count IN {1, 2}" match
      // nothing while "== ANY {...}" does, and "l.tags.@count IN {...}" matches
      // objects without l. Not reproduced; on the base object IN works.
      throw new Unsupported('IN with several values on @count/@size through a link, a list or an embedded object (the SDK gives unexplained results)');
    }
    const pred = leafPredicate({ sql: countExpr, type: 'int' }, { ...node, throughList: outer.length > 0 });
    if (outer.length) return `EXISTS (SELECT 1 ${subquery(outer, pred)})`;
    // Through a null link (measured): the count of a list of objects, of
    // backlinks or of embedded objects makes every comparison false (even !=);
    // a list of values counts 0; the size of a string is null (!= 0 is true).
    const values = !str && levels[levels.length - 1].kind === 'values';
    return guard && !str && !values ? `(${guard} IS NOT NULL AND ${pred})` : pred;
  }

  function compileCmp(node) {
    const { left, quant } = node;
    const w = walk(left.segs);
    const { levels } = w;
    // With the value on the left ("1.5 > height"), the SDK compares a base
    // property like one reached through a link. For doubles (quirk): NaN is below
    // every number and NaN == NaN, so "1.5 > height" includes NaN and "height < 1.5"
    // does not. For strings: no null-below rule ("b" > name excludes nulls).
    const flip = node.flipped && (((w.leaf.type === 'double' || w.leaf.type === 'float') && quirks) || w.leaf.type === 'string');
    const leaf = flip ? { ...w.leaf, direct: false } : w.leaf;
    if (left.agg) return compileCount(node, w, leaf);
    if (leaf.type === 'embedded list') {
      // Measured: the SDK refuses a list of embedded objects compared with a
      // value (an embedded object, another object, a number, null).
      if (node.right.t !== 'path' && (node.op === '==' || node.op === '!=')) throw new RqlError(`cannot compare the list of embedded objects ${leaf.emb} with a value (the SDK refuses it too)`);
      throw new Unsupported('comparing a whole embedded list');
    }
    // Measured over the 300 objects of the differential test: a list of
    // backlinks of the base object compared with an object, with ANY or no
    // quantifier ("ANY fans == $0", "fans != $0", "fans == ANY {$0}"), gives
    // SDK rows that are not the element test ("ANY fans == $0" matched nothing).
    // ALL and NONE, backlinks further down the key path ("ANY friends.fans ==
    // $0", "boss.fans == $0"), "$0 == fans", "ANY fans IN {…}" and "fans == boss"
    // give the element test.
    if (leaf.backlink && left.segs.length === 1 && (!quant || quant === 'ANY') && !node.flipped && node.right.t !== 'path' && (node.op === '==' || node.op === '!=' || node.anyList)) {
      const r = node.right;
      const isNullValue = (r.t === 'lit' && r.v === null) || (r.t === 'arg' && argValue(r.i) == null);
      if (!(isNullValue && node.op !== 'IN')) throw new Unsupported('a list of backlinks compared with an object (the SDK gives other rows); write "$0 == fans" or "ANY fans IN {$0}"');
    }
    // [c] on a non-string: see valueCi().
    node = { ...node, throughList: levels.length > 0, base: left.segs.length === 1 && (levels.length === 0 || leaf.type === 'link') };
    if (levels.length && (leaf.type === 'link' || leaf.type === 'embedded') && node.op !== 'IN') {
      const r = node.right;
      if ((r.t === 'lit' && r.v === null) || (r.t === 'arg' && argValue(r.i) == null)) throw new RqlError(`cannot compare a list of ${leaf.type === 'link' ? 'links' : 'embedded objects'} with null (the SDK refuses it too); use @count == 0`);
    }
    // Measured: "ANY friends IN {null}", "friends.boss == ANY {null}", "IN $0"
    // with [null] are refused by the SDK too; with more values ("IN {null, $0}",
    // "IN {null, null}") a null matches nothing.
    if (levels.length && leaf.type === 'link' && node.op === 'IN') {
      const items = inItems(node.right);
      if (items.length === 1 && items[0].v == null) throw new RqlError('cannot compare a list of links with null (the SDK refuses it too); use @count == 0');
    }
    if (levels.length && leaf.type === 'embedded') throw new Unsupported('comparing an embedded object reached through a list');
    if (!levels.length) {
      if (quant) throw new RqlError(`${quant} needs a key path through a list`);
      return leafPredicate(leaf, node);
    }
    if (node.op === 'IN' && !quant && !node.anyList && quirks) {
      // Without ANY, "list IN {a, b}" is true when the list equals [a, b] (same
      // order). "list == ANY {a, b}" is the element test (below).
      if (levels.length !== 1 || !levels[0].pos || node.right.t !== 'list') throw new Unsupported('list IN {...} without ANY on this key path');
      // Measured: through a to-one link after the list ("friends.city.name IN
      // {...}", "friends.boss IN {...}") the SDK rows are not this comparison.
      if (levels[0].toOne || levels[0].conds.length) throw new Unsupported('list IN {...} without ANY through a link or an embedded object after the list');
      warnings.push('SDK semantics: "list IN {...}" without ANY compares the whole list.');
      const items = node.right.items.map((it) => (it.t === 'arg' ? argValue(it.i) : it.v));
      const ci = valueCi(leaf, node);
      const count = `(SELECT count(*) ${subquery(levels)}) = ${items.length}`;
      if (!items.length) return `(${count})`;
      const at = items.map((v, i) => `(${levels[0].pos} = ${i} AND ${cmpValue(leaf, '==', v, ci, { soft: node.right.items[i].t === 'lit' })})`).join(' OR ');
      return `(${count} AND NOT EXISTS (SELECT 1 ${subquery(levels, `NOT (${at})`)}))`;
    }
    const pred = leafPredicate(leaf, node);
    const qn = quant ?? 'ANY';
    if (qn === 'ANY') return `EXISTS (SELECT 1 ${subquery(levels, pred)})`;
    const inner = (L) => (qn === 'ALL' ? `NOT EXISTS (SELECT 1 ${subquery(L, `NOT (${pred})`)})` : `NOT EXISTS (SELECT 1 ${subquery(L, pred)})`);
    if (levels.length === 1) return inner(levels);
    if (levels.length === 2) {
      // Two lists of objects (links or backlinks): ALL/NONE apply to every
      // object reached through both ("ALL friends.friends.age > 3").
      if (levels[1].kind === 'links' || levels[1].kind === 'backlinks') return inner(levels);
      // A list of objects, then a list of values: ALL/NONE apply to the last
      // list, the first one is ANY, and an empty first list matches.
      if (levels[1].kind === 'values') return `(NOT EXISTS (SELECT 1 ${subquery([levels[0]])}) OR EXISTS (SELECT 1 ${subquery([levels[0]], inner([levels[1]]))}))`;
      throw new Unsupported(`${qn} over a list of embedded objects inside a list`);
    }
    throw new Unsupported(`${qn} over more than two nested lists`);
  }

  function compile(node) {
    switch (node.t) {
      case 'const': return node.v ? '1' : '0';
      case 'not': return `NOT (${compile(node.e)})`;
      case 'and': return '(' + node.items.map(compile).join(' AND ') + ')';
      case 'or': return '(' + node.items.map(compile).join(' OR ') + ')';
      case 'cmp': return compileCmp(node);
      default: throw new RqlError(`node ${node.t}`);
    }
  }

  const where = compile(ast.where);
  const order = [];
  for (const s of ast.sort) {
    const { leaf, guard } = walk(s.path.segs, { forSort: true });
    if (leaf.type === 'embedded' || leaf.type === 'link') throw new Unsupported('SORT on an object');
    const dir = s.desc ? ' DESC' : '';
    // Objects whose to-one path is broken (null link) sort after all values.
    if (guard) order.push(`(${guard} IS NULL)${dir}`);
    // SDK order for doubles: null < NaN < numbers.
    if (leaf.special) order.push(`(CASE WHEN ${leaf.sql} IS NOT NULL THEN 2 WHEN ${leaf.special} = 'NaN' THEN 1 ELSE 0 END)${dir}`);
    order.push(`${leaf.sql}${dir}`);
  }
  if (ast.sort.length) order.push(`b.${keyCol(base)}`); // deterministic ties

  let limit = ast.limit;
  // SDK 20.2: a predicate that is exactly "<int property> IN {...}" ignores LIMIT.
  const w = ast.where;
  const quirkIn = w.t === 'cmp' && w.op === 'IN' && !w.quant && w.left.segs.length === 1 && !w.left.agg &&
    (() => { const [, d] = prop(base, base.name, w.left.segs[0]); return d.kind === 'scalar' && d.type === 'int'; })();
  if (quirks && quirkIn && limit) {
    if (ast.sort.length) warnings.push('SDK quirk not reproduced: with SORT, the SDK reports the unlimited count but only LIMIT objects are readable.');
    else { warnings.push('SDK quirk reproduced: LIMIT ignored after "<int> IN {...}".'); limit = null; }
  }
  if (limit !== null && !ast.sort.length) warnings.push('LIMIT without SORT: the SDK keeps the first objects in insertion order, SQL in primary key order.');

  const cols = select ?? `b.${keyCol(base)}`;
  let sql = `SELECT ${cols} FROM ${q(base.table)} b`;
  if (outerJoins.length) sql += ' ' + outerJoins.join(' ');
  sql += ` WHERE ${where}`;
  if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
  if (limit !== null) sql += ` LIMIT ${limit}`;
  return { sql, params, warnings, sorted: ast.sort.length > 0, limit: ast.limit };
}
