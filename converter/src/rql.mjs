// Translate a subset of the SDK query language (RQL) to SQL over the schema
// produced by convert.mjs. The goal is the same result set as the SDK,
// including its documented quirks (see README).

import { q } from './model.mjs';

export class RqlError extends Error {}
export class Unsupported extends RqlError {}

// ---------- tokenizer ----------

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'ANY', 'SOME', 'ALL', 'NONE', 'IN', 'BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE',
  'SORT', 'LIMIT', 'DISTINCT', 'ASC', 'DESC', 'ASCENDING', 'DESCENDING', 'TRUEPREDICATE', 'FALSEPREDICATE', 'TRUE', 'FALSE', 'NULL', 'NIL', 'BETWEEN']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  const valueEnd = () => {
    const t = toks[toks.length - 1];
    return t && (t.k === 'num' || t.k === 'str' || t.k === 'id' || t.k === 'arg' || (t.k === 'p' && (t.v === ')' || t.v === '}')));
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          const e = src[++i];
          if (e === 'n') s += '\n';
          else if (e === 't') s += '\t';
          else if (e === 'u') { s += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)); i += 4; }
          else s += e;
          i++;
        } else s += src[i++];
      }
      if (src[i] !== c) throw new RqlError('unterminated string');
      i++;
      toks.push({ k: 'str', v: s });
      continue;
    }
    const num = /^-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    if (num && (c !== '-' || !valueEnd())) {
      toks.push({ k: 'num', v: Number(num[0]), raw: num[0] });
      i += num[0].length;
      continue;
    }
    if (c === '$') {
      const m = /^\$(\d+)/.exec(src.slice(i));
      if (!m) throw new RqlError('bad argument');
      toks.push({ k: 'arg', v: Number(m[1]) });
      i += m[0].length;
      continue;
    }
    const id = /^@?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      const w = id[0];
      i += w.length;
      if (KEYWORDS.has(w.toUpperCase())) toks.push({ k: 'kw', v: w.toUpperCase() });
      else toks.push({ k: 'id', v: w });
      continue;
    }
    const mod = /^\[([cdCD]+)\]/.exec(src.slice(i));
    if (mod) { toks.push({ k: 'mod', v: mod[1].toLowerCase() }); i += mod[0].length; continue; }
    const p = /^(==|!=|<>|<=|>=|&&|\|\||=|<|>|!|\(|\)|\{|\}|,|\.)/.exec(src.slice(i));
    if (p) { toks.push({ k: 'p', v: p[0] }); i += p[0].length; continue; }
    throw new RqlError(`unexpected character "${c}" at ${i}`);
  }
  toks.push({ k: 'eof' });
  return toks;
}

// ---------- parser ----------

const CMP = { '==': '==', '=': '==', '!=': '!=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const FLIP = { '==': '==', '!=': '!=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

export function parse(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const isKw = (v) => t[i].k === 'kw' && t[i].v === v;
  const isP = (v) => t[i].k === 'p' && t[i].v === v;
  const expectP = (v) => { if (!isP(v)) throw new RqlError(`expected "${v}"`); i++; };

  function operand() {
    const tok = peek();
    if (tok.k === 'num') { i++; return { t: 'lit', v: tok.v, int: /^-?\d+$/.test(tok.raw) }; }
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
        if (isP(',')) i++;
        else break;
      }
      expectP('}');
      return { t: 'list', items };
    }
    if (tok.k === 'id') {
      const segs = [tok.v];
      i++;
      while (isP('.')) {
        i++;
        if (peek().k !== 'id') throw new RqlError('expected property name after "."');
        segs.push(peek().v);
        i++;
      }
      let agg = null;
      if (segs[segs.length - 1].startsWith('@')) agg = segs.pop();
      if (segs.some((s) => s.startsWith('@'))) throw new Unsupported(`operator inside key path: ${segs.join('.')}`);
      if (agg && !['@count', '@size'].includes(agg)) throw new Unsupported(`${agg} is not supported`);
      return { t: 'path', segs, agg };
    }
    throw new RqlError(`unexpected token ${tok.v ?? tok.k}`);
  }

  function comparison() {
    let quant = null;
    if (['ANY', 'SOME', 'ALL', 'NONE'].some(isKw)) { quant = peek().v === 'SOME' ? 'ANY' : peek().v; i++; }
    let left = operand();
    let op;
    const tok = peek();
    if (tok.k === 'p' && CMP[tok.v]) { op = CMP[tok.v]; i++; }
    else if (tok.k === 'kw' && ['BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE', 'IN'].includes(tok.v)) { op = tok.v; i++; }
    else if (tok.k === 'kw' && tok.v === 'BETWEEN') throw new Unsupported('BETWEEN');
    else throw new RqlError(`expected an operator, got ${tok.v ?? tok.k}`);
    let ci = false;
    if (peek().k === 'mod') {
      const m = peek().v;
      if (m.includes('d')) throw new Unsupported('[d] modifier');
      ci = m.includes('c');
      i++;
    }
    // "x == ANY {a, b}" is the same as "x IN {a, b}".
    if (op === '==' && isKw('ANY') && t[i + 1].k === 'p' && t[i + 1].v === '{') { i++; op = 'IN'; }
    let right = operand();
    if (op === 'IN' && right.t === 'arg') right = { t: 'argList', i: right.i };
    if (left.t !== 'path' && right.t === 'path') {
      if (!FLIP[op]) throw new Unsupported(`value on the left of ${op}`);
      [left, right] = [right, left];
      op = FLIP[op];
    }
    if (left.t !== 'path') throw new RqlError('comparison needs a key path');
    if (op === 'IN' && right.t !== 'list' && right.t !== 'argList') throw new Unsupported('IN needs a {list} or a list argument');
    return { t: 'cmp', quant, left, op, right, ci };
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
  const sort = [];
  let limit = null;
  while (peek().k === 'kw') {
    if (isKw('SORT')) {
      i++;
      expectP('(');
      for (;;) {
        const p = operand();
        if (p.t !== 'path' || p.agg) throw new RqlError('SORT needs key paths');
        let desc = false;
        if (['ASC', 'ASCENDING'].some(isKw)) i++;
        else if (['DESC', 'DESCENDING'].some(isKw)) { desc = true; i++; }
        else throw new RqlError('SORT needs ASC or DESC');
        sort.push({ path: p, desc });
        if (isP(',')) { i++; continue; }
        break;
      }
      expectP(')');
    } else if (isKw('LIMIT')) {
      i++;
      expectP('(');
      const n = peek();
      if (n.k !== 'num' || !Number.isInteger(n.v) || n.v < 0) throw new RqlError('LIMIT needs a non-negative integer');
      i++;
      expectP(')');
      limit = limit === null ? n.v : Math.min(limit, n.v);
    } else if (isKw('DISTINCT')) {
      throw new Unsupported('DISTINCT');
    } else break;
  }
  if (peek().k !== 'eof') throw new RqlError(`unexpected token ${peek().v}`);
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

const isSdkObject = (v) => v !== null && typeof v === 'object' && typeof v.objectSchema === 'function' && typeof v._objectKey === 'function';

const TEXT_OPS = new Set(['BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE']);

/**
 * @param {string|object} query RQL text (or parsed AST)
 * @param {{model, className, args?, quirks?, select?}} opts
 *   quirks (default true): reproduce SDK 20.2 behaviours that look like bugs (see README).
 * @returns {{sql, params, warnings, sorted, limit}}
 */
export function translate(query, { model, className, args = [], quirks = true, select } = {}) {
  if (!model?.classes?.[className]) throw new RqlError(`unknown class ${className}`);
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

  function toSql(leaf, v) {
    if (v === null || v === undefined) return null;
    if (isSdkObject(v)) {
      const name = v.objectSchema().name;
      const t = model.classes[name];
      if (!t) throw new RqlError(`object of unknown class ${name}`);
      return t.key.synthetic ? Number(v._objectKey()) : toSql({ type: t.key.type }, v[t.key.column]);
    }
    if (v instanceof Date) return quirks ? sdkDateMs(v.getTime()) : v.getTime();
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object' && typeof v.toHexString === 'function') return leaf.type === 'uuid' ? v.toString() : v.toHexString();
    return v;
  }

  /**
   * Walk a key path from the base class. Collections open "levels" (one per
   * list, backlink or embedded list); to-one links are LEFT JOINs outside any
   * level and inner JOINs inside one (the SDK drops null links there).
   */
  function walk(segs, { forSort = false } = {}) {
    let cls = base;
    let a = 'b';
    const levels = [];
    let guard = null; // expression that is NULL when a to-one hop is missing (for SORT)
    let json = null; // inside an embedded object: {expr, path, emb}
    const cur = () => levels[levels.length - 1];
    const level = (first, corr, pos) => {
      if (forSort) throw new RqlError('cannot sort on a list');
      levels.push({ first, corr, joins: [], pos });
    };
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      const last = k === segs.length - 1;
      if (json) {
        const d = model.embedded[json.emb].props[s];
        if (!d) throw new RqlError(`unknown property ${json.emb}.${s}`);
        const path = `${json.path}.${JSON.stringify(s)}`;
        if (d.kind === 'scalar') {
          if (!last) throw new RqlError(`${s} is not a link`);
          if (!['int', 'string', 'bool'].includes(d.type)) throw new Unsupported(`embedded ${d.type} field in a query`);
          return { leaf: { sql: `json_extract(${json.expr}, '${path}')`, type: d.type }, levels, guard };
        }
        if (d.kind === 'embedded' && !d.many) {
          json = { ...json, path, emb: d.target };
          if (last) return { leaf: { sql: `json_extract(${json.expr}, '${path}')`, type: 'embedded' }, levels, guard };
          continue;
        }
        throw new Unsupported(`embedded ${d.kind} in a key path`);
      }
      const d = cls.props[s];
      if (!d) throw new RqlError(`unknown property ${cls.name}.${s}`);
      if (d.kind === 'scalar') {
        if (!last) throw new RqlError(`${cls.name}.${s} is not a link`);
        const direct = k === 0;
        return { leaf: { sql: `${a}.${q(d.column)}`, special: d.special ? `${a}.${q(d.special)}` : null, type: d.type, direct }, levels, guard };
      }
      if (d.kind === 'link') {
        if (last) return { leaf: { sql: `${a}.${q(d.column)}`, type: 'link', target: d.target }, levels, guard };
        const target = model.classes[d.target];
        const x = alias();
        if (levels.length) {
          cur().joins.push(`JOIN ${q(target.table)} ${x} ON ${x}.${keyCol(target)} = ${a}.${q(d.column)}`);
        } else {
          const jk = `${a}.${s}`;
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
        if (d.many) {
          const j = alias();
          level(`json_each(${a}.${q(d.column)}) ${j}`, null, `${j}.key`);
          json = { expr: `${j}.value`, path: '$', emb: d.target };
        } else {
          json = { expr: `${a}.${q(d.column)}`, path: '$', emb: d.target };
          if (!levels.length) guard = json.expr;
        }
        if (last) {
          if (d.many) throw new Unsupported('comparing a whole embedded list');
          return { leaf: { sql: json.expr, type: 'embedded' }, levels, guard };
        }
        continue;
      }
      if (d.kind === 'list') {
        const l = alias();
        level(`${q(d.table)} ${l}`, `${l}."owner" = ${a}.${keyCol(cls)}`, `${l}."pos"`);
        if (d.elem.type !== 'object') {
          if (!last) throw new RqlError(`${cls.name}.${s} is a list of values`);
          return { leaf: { sql: `${l}."value"`, special: d.elem.special ? `${l}.${q(d.elem.special)}` : null, type: d.elem.type, inList: true }, levels, guard };
        }
        if (last) return { leaf: { sql: `${l}."target"`, type: 'link', target: d.elem.target }, levels, guard };
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
        level(`${q(d.view)} ${v}`, `${v}."owner" = ${a}.${keyCol(cls)}`, null);
        if (last) return { leaf: { sql: `${v}."source"`, type: 'link', target: src.name }, levels, guard };
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

  // SELECT 1 FROM <levels> WHERE <correlation> AND <extra>
  function subquery(levels, extra) {
    let from = `${levels[0].first}${levels[0].joins.length ? ' ' + levels[0].joins.join(' ') : ''}`;
    for (const L of levels.slice(1)) from += ` JOIN ${L.first} ON ${L.corr ?? '1'}${L.joins.length ? ' ' + L.joins.join(' ') : ''}`;
    const where = [levels[0].corr, extra].filter(Boolean);
    return `FROM ${from}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  }

  // NULL test that knows about the NaN companion column.
  const isNull = (leaf) => (leaf.special ? `(${leaf.sql} IS NULL AND ${leaf.special} IS NULL)` : `${leaf.sql} IS NULL`);
  const isNaNSql = (leaf) => `IFNULL(${leaf.special} = 'NaN', 0)`;

  /**
   * Comparison with null, as observed in the SDK: null is the smallest value of
   * a string property on the base class; elsewhere <= and >= behave like ==.
   * Text operators: LIKE null is "== null"; CONTAINS, BEGINSWITH and ENDSWITH
   * null are true on base properties; elsewhere CONTAINS null means "not null"
   * and BEGINSWITH / ENDSWITH null are false.
   */
  function cmpNull(leaf, op) {
    const directString = leaf.direct && leaf.type === 'string';
    switch (op) {
      case '==': case 'LIKE': return isNull(leaf);
      case '!=': return `NOT ${isNull(leaf)}`;
      case '<': return '0';
      case '>': return directString ? `NOT ${isNull(leaf)}` : '0';
      case '<=': return isNull(leaf);
      case '>=': return directString ? '1' : isNull(leaf);
      case 'CONTAINS': return leaf.direct ? '1' : `NOT ${isNull(leaf)}`;
      case 'BEGINSWITH': case 'ENDSWITH': return leaf.direct ? '1' : '0';
      default: throw new RqlError(`operator ${op}`);
    }
  }

  /** Two-valued SQL (0/1, never NULL) comparing a leaf with one value. */
  function cmpValue(leaf, op, raw, ci, intLiteral = false) {
    let v = toSql(leaf, raw);
    if (leaf.type === 'embedded' && v !== null) throw new Unsupported('comparing an embedded object with a value');
    if (v === null) return cmpNull(leaf, op);
    const float = leaf.type === 'double' || leaf.type === 'float';
    // Values compared with a float property are rounded to float first (1e-300 becomes 0).
    if (leaf.type === 'float' && typeof v === 'number') v = Math.fround(v);
    if (float && typeof v === 'number' && Number.isNaN(v)) {
      if (leaf.direct || !leaf.special) return op === '!=' ? '1' : '0'; // IEEE on base properties
      // Through links and in lists the SDK orders NaN below every number and NaN == NaN.
      switch (op) {
        case '==': case '<=': return isNaNSql(leaf);
        case '!=': case '>': return `NOT ${isNaNSql(leaf)}`;
        case '<': return '0';
        case '>=': return '1';
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
        if (leaf.type === 'link' || leaf.type === 'bool') throw new RqlError(`${op} on ${leaf.type}`);
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
      case 'BEGINSWITH': return `IFNULL(substr(${x}, 1, length(${P(v)})) = ${P(v)}, 0)`;
      case 'ENDSWITH': return v === '' ? `(${x} IS NOT NULL)` : `IFNULL(substr(${x}, -length(${P(v)})) = ${P(v)}, 0)`;
      case 'CONTAINS': return `IFNULL(instr(${x}, ${P(v)}) > 0, 0)`;
      case 'LIKE': return `IFNULL(${x} GLOB ${P(v.replace(/\[/g, '[[]'))}, 0)`;
      default: throw new RqlError(`operator ${op}`);
    }
  }

  function leafPredicate(leaf, node) {
    const { op, right } = node;
    let ci = node.ci;
    if (op === 'IN') {
      if (quirks && ci && leaf.direct) { ci = false; warnings.push('SDK quirk reproduced: [c] is ignored by IN on a base property.'); }
      let items = right.t === 'list' ? right.items.map((it) => (it.t === 'arg' ? { v: argValue(it.i) } : it)) : [...argValue(right.i)].map((v) => ({ v }));
      if (quirks && leaf.direct && (leaf.type === 'double' || leaf.type === 'float') && right.t === 'list') {
        // SDK 20.2: integer literals in IN on a float/double property never match,
        // and a list made only of integer literals matches every object.
        if (items.length && items.every((it) => it.int)) { warnings.push('SDK quirk reproduced: integer-only IN on a double matches all.'); return '1'; }
        items = items.filter((it) => !it.int);
      }
      if (!items.length) return '0';
      return '(' + items.map((it) => cmpValue(leaf, '==', it.v, ci)).join(' OR ') + ')';
    }
    if (right.t === 'path') {
      const r = walk(right.segs);
      if (r.levels.length || right.agg) throw new Unsupported('comparing two key paths through a list');
      if (leaf.special || r.leaf.special) throw new Unsupported('comparing two double key paths');
      let x = leaf.sql, y = r.leaf.sql;
      if (ci) { x = foldSql(x); y = foldSql(y); }
      switch (op) {
        case 'BEGINSWITH': return `IFNULL(substr(${x}, 1, length(${y})) = ${y}, 0)`;
        case 'ENDSWITH': return `IFNULL(CASE WHEN length(${y}) = 0 THEN ${x} IS NOT NULL ELSE substr(${x}, -length(${y})) = ${y} END, 0)`;
        case 'CONTAINS': return `IFNULL(instr(${x}, ${y}) > 0, 0)`;
        case 'LIKE': throw new Unsupported('LIKE between two key paths');
        case '==': return `(IFNULL(${x} = ${y}, 0) OR (${x} IS NULL AND ${y} IS NULL))`;
        case '!=': return `NOT (IFNULL(${x} = ${y}, 0) OR (${x} IS NULL AND ${y} IS NULL))`;
        default: return `IFNULL(${x} ${op} ${y}, 0)`;
      }
    }
    if (right.t === 'arg') return cmpValue(leaf, op, argValue(right.i), ci);
    return cmpValue(leaf, op, right.v, ci, right.int);
  }

  function compileCmp(node) {
    const { left, quant } = node;
    const { leaf, levels, guard } = walk(left.segs);
    if (left.agg) {
      if (quant) throw new RqlError(`${quant} with ${left.agg}`);
      let countExpr;
      if (levels.length) countExpr = `(SELECT count(*) ${subquery(levels)})`;
      else if (left.agg === '@size' && (leaf.type === 'string' || leaf.type === 'data')) countExpr = `length(CAST(${leaf.sql} AS BLOB))`; // bytes
      else throw new RqlError(`${left.agg} on a non-collection`);
      const pred = leafPredicate({ sql: countExpr, type: 'int' }, node);
      // Through a null link every count comparison is false (even !=).
      return guard ? `(${guard} IS NOT NULL AND ${pred})` : pred;
    }
    if (!levels.length) {
      if (quant) throw new RqlError(`${quant} needs a key path through a list`);
      return leafPredicate(leaf, node);
    }
    if (node.op === 'IN' && !quant && quirks) {
      // Without ANY, "list IN {a, b}" is true when the list equals [a, b] (same order).
      if (levels.length !== 1 || !levels[0].pos || node.right.t !== 'list') throw new Unsupported('list IN {...} without ANY on this key path');
      warnings.push('SDK semantics: "list IN {...}" without ANY compares the whole list.');
      const items = node.right.items.map((it) => (it.t === 'arg' ? argValue(it.i) : it.v));
      const count = `(SELECT count(*) ${subquery(levels)}) = ${items.length}`;
      if (!items.length) return `(${count})`;
      const at = items.map((v, i) => `(${levels[0].pos} = ${i} AND ${cmpValue(leaf, '==', v, node.ci)})`).join(' OR ');
      return `(${count} AND NOT EXISTS (SELECT 1 ${subquery(levels, `NOT (${at})`)}))`;
    }
    const pred = leafPredicate(leaf, node);
    const qn = quant ?? 'ANY';
    if (qn === 'ANY') return `EXISTS (SELECT 1 ${subquery(levels, pred)})`;
    const inner = (L) => (qn === 'ALL' ? `NOT EXISTS (SELECT 1 ${subquery(L, `NOT (${pred})`)})` : `NOT EXISTS (SELECT 1 ${subquery(L, pred)})`);
    if (levels.length === 1) return inner(levels);
    if (levels.length === 2) {
      // SDK semantics with two lists: ALL/NONE apply to the last list, the
      // first one is ANY, and an empty first list matches.
      return `(NOT EXISTS (SELECT 1 ${subquery([levels[0]])}) OR EXISTS (SELECT 1 ${subquery([levels[0]], inner([levels[1]]))}))`;
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
    base.props[w.left.segs[0]]?.kind === 'scalar' && base.props[w.left.segs[0]].type === 'int';
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
