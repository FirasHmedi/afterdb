// Build the SQL model (tables, columns, views) from a canonical object schema.
// The model is plain JSON: it is stored in the output file (_afterdb_meta) and
// reused by verify.mjs and rql.mjs.

export const MODEL_VERSION = 1;

const SCALAR_SQL = {
  int: 'INTEGER',
  bool: 'INTEGER',
  float: 'REAL',
  double: 'REAL',
  string: 'TEXT',
  data: 'BLOB',
  date: 'INTEGER',
  decimal128: 'TEXT',
  objectId: 'TEXT',
  uuid: 'TEXT',
};
const PK_TYPES = new Set(['int', 'string', 'objectId', 'uuid']);

export const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
export const isFloat = (t) => t === 'double' || t === 'float';
export const SPECIAL_SUFFIX = '__x';

// Columns for one scalar value; doubles get a companion column for NaN and -0.
function scalarCols(name, type, optional, x = name + SPECIAL_SUFFIX) {
  const cols = [{ name, sql: SCALAR_SQL[type], notNull: !optional, check: null }];
  if (type === 'bool') cols[0].check = `${q(name)} IN (0,1)`;
  if (isFloat(type)) {
    // The REAL column is NULL for NaN, so NOT NULL is enforced on the pair.
    cols[0].notNull = false;
    cols.push({ name: x, sql: 'TEXT', notNull: false, check: `${q(x)} IN ('NaN','-0')` });
    if (!optional) cols[0].check = `${q(name)} IS NOT NULL OR ${q(x)} = 'NaN'`;
  }
  return cols;
}

// SQLite folds ASCII letters only when comparing identifiers.
const fold = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
export const META_TABLE = '_afterdb_meta';

/**
 * Case-insensitive name registry. A taken name gets the first free suffix
 * "_2", "_3"...; names starting with "sqlite_" (reserved) get a "_" prefix.
 */
export class Names {
  constructor(reserved = []) { this.used = new Set(reserved.map(fold)); }
  has(n) { return this.used.has(fold(n)); }
  take(want) {
    const base = /^sqlite_/i.test(want) ? '_' + want : want;
    let n = base;
    for (let i = 2; this.has(n); i++) n = `${base}_${i}`;
    this.used.add(fold(n));
    return n;
  }
}

/**
 * @param {Array} schema canonical schema (realm.schema)
 * @returns {{model: object, warnings: string[]}}
 */
export function buildModel(schema) {
  const warnings = [];
  const byName = new Map(schema.map((c) => [c.name, c]));
  const model = { version: MODEL_VERSION, classes: {}, embedded: {}, renames: [] };

  // Keys first: links need the key type of their target.
  const keyOf = new Map();
  const renames = [];
  const named = (r) => {
    renames.push(r);
    const what = r.prop ? `${r.class}.${r.prop}` : r.class;
    warnings.push(`${what}: ${r.kind} stored as "${r.to}" because "${r.from}" clashes with another name (SQLite ignores case; ${META_TABLE} and sqlite_* are reserved).`);
  };
  // Class tables first, in code-unit order, so a class keeps its name before generated ones.
  const global = new Names([META_TABLE]);
  const generated = (cls, prop, kind, want) => {
    const g = global.take(want);
    if (g !== want) named({ kind, class: cls, prop, from: want, to: g });
    return g;
  };
  const tableOf = new Map();
  for (const cls of [...schema].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (cls.embedded || cls.asymmetric) continue;
    const t = global.take(cls.name);
    if (t !== cls.name) named({ kind: 'table', class: cls.name, from: cls.name, to: t });
    tableOf.set(cls.name, t);
  }
  for (const cls of schema) {
    if (cls.embedded || cls.asymmetric) continue;
    const pk = cls.primaryKey ? cls.properties[cls.primaryKey] : null;
    if (pk && PK_TYPES.has(pk.type) && !pk.optional) {
      keyOf.set(cls.name, { column: pk.name, type: pk.type, sql: SCALAR_SQL[pk.type], synthetic: false });
    } else {
      if (pk) warnings.push(`${cls.name}: optional primary key "${pk.name}" kept as a UNIQUE column; rows keyed by synthetic _rid.`);
      keyOf.set(cls.name, { column: '_rid', type: 'int', sql: 'INTEGER', synthetic: true });
    }
  }

  const describe = (owner, p) => {
    const t = p.type;
    if (SCALAR_SQL[t]) return { kind: 'scalar', type: t, optional: !!p.optional };
    if (t === 'object') {
      const target = byName.get(p.objectType);
      if (!target) throw new Error(`${owner}.${p.name}: unknown class ${p.objectType}`);
      if (target.embedded) return { kind: 'embedded', target: target.name, many: false, optional: true };
      return { kind: 'link', target: target.name, optional: true };
    }
    if (t === 'list') {
      const elemType = p.objectType;
      const target = byName.get(elemType);
      if (target?.embedded) return { kind: 'embedded', target: target.name, many: true, optional: false };
      if (target) return { kind: 'list', elem: { type: 'object', target: target.name } };
      if (elemType === 'mixed') return { kind: 'json', ctype: 'list', elem: { type: 'mixed', optional: true } };
      if (!SCALAR_SQL[elemType]) throw new Error(`${owner}.${p.name}: unsupported list element ${elemType}`);
      return { kind: 'list', elem: { type: elemType, optional: !!p.optional } };
    }
    if (t === 'set' || t === 'dictionary') {
      const target = byName.get(p.objectType);
      const elem = target
        ? (target.embedded ? { type: 'embedded', target: target.name } : { type: 'object', target: target.name })
        : { type: p.objectType, optional: !!p.optional };
      return { kind: 'json', ctype: t, elem };
    }
    if (t === 'mixed') return { kind: 'json', ctype: 'mixed', elem: { type: 'mixed', optional: true } };
    if (t === 'linkingObjects') return { kind: 'backlink', source: p.objectType, sourceProp: p.property };
    throw new Error(`${owner}.${p.name}: unsupported type ${t}`);
  };

  for (const cls of schema) {
    if (cls.asymmetric) {
      warnings.push(`${cls.name}: asymmetric class skipped (not stored locally).`);
      continue;
    }
    const props = {};
    // Public names (mapTo) of the app schema -> stored names, for queries (rql.mjs).
    const aliases = {};
    for (const p of Object.values(cls.properties)) {
      const d = describe(cls.name, p);
      if (p.type === 'int' && p.presentation === 'counter') d.counter = true;
      if (p.indexed && !(cls.primaryKey === p.name)) d.indexed = true;
      props[p.name] = d;
      if (typeof p.publicName === 'string') aliases[p.publicName] = p.name;
    }
    // Names of the app schema that the output does not hold (rql.mjs raises Unsupported for them).
    const skipped = {};
    const extra = (o) => {
      if (Object.keys(aliases).length) o.aliases = aliases;
      if (Object.keys(skipped).length) o.skipped = skipped;
      return o;
    };
    if (cls.embedded) {
      for (const [n, d] of Object.entries(props)) {
        if (d.kind === 'backlink') {
          warnings.push(`${cls.name}.${n}: backlink on an embedded class is not converted.`);
          delete props[n];
          skipped[n] = 'a backlink on an embedded class';
        }
      }
      model.embedded[cls.name] = extra({ props });
      continue;
    }
    const key = keyOf.get(cls.name);
    const tname = tableOf.get(cls.name);
    const table = extra({ name: cls.name, table: tname, key, primaryKey: cls.primaryKey ?? null, props, columns: [], lists: [], views: [] });
    if (key.synthetic) {
      if (props._rid) throw new Error(`${cls.name}: a class without primary key cannot have a property named "_rid" (reserved for the row key)`);
      table.columns.push({ name: '_rid', sql: 'INTEGER', pk: true, notNull: true });
    }
    // Column names: the key column keeps its name, the others are made unique.
    const colNames = new Names([key.column]);
    const col = (n, want = n) => {
      if (!key.synthetic && n === key.column && want === n) return n;
      const c = colNames.take(want);
      if (c !== want) named({ kind: 'column', class: cls.name, prop: n, from: want, to: c });
      return c;
    };

    for (const [n, d] of Object.entries(props)) {
      if (d.kind === 'scalar') {
        d.column = col(n);
        if (isFloat(d.type)) d.special = col(n, d.column + SPECIAL_SUFFIX);
        const cols = scalarCols(d.column, d.type, d.optional, d.special);
        if (!key.synthetic && n === key.column) Object.assign(cols[0], { pk: true, notNull: true });
        if (key.synthetic && n === cls.primaryKey) cols[0].unique = true;
        table.columns.push(...cols);
      } else if (d.kind === 'link') {
        const tk = keyOf.get(d.target);
        d.column = col(n);
        table.columns.push({ name: d.column, sql: tk.sql, notNull: false, fk: { table: tableOf.get(d.target), column: tk.column, onDelete: 'SET NULL' } });
      } else if (d.kind === 'embedded' || d.kind === 'json') {
        d.column = col(n);
        const notNull = d.kind === 'embedded' ? d.many : d.ctype !== 'mixed';
        table.columns.push({ name: d.column, sql: 'TEXT', notNull, check: `json_valid(${q(d.column)})` });
      } else if (d.kind === 'list') {
        d.table = generated(cls.name, n, 'list table', `${tname}__${n}`);
        const cols = [
          { name: 'owner', sql: key.sql, notNull: true, fk: { table: tname, column: key.column, onDelete: 'CASCADE' } },
          { name: 'pos', sql: 'INTEGER', notNull: true },
        ];
        if (d.elem.type === 'object') {
          const tk = keyOf.get(d.elem.target);
          cols.push({ name: 'target', sql: tk.sql, notNull: true, fk: { table: tableOf.get(d.elem.target), column: tk.column, onDelete: 'CASCADE' } });
        } else {
          cols.push(...scalarCols('value', d.elem.type, d.elem.optional));
          if (isFloat(d.elem.type)) d.elem.special = 'value' + SPECIAL_SUFFIX;
        }
        table.lists.push({ table: d.table, prop: n, columns: cols });
      } else if (d.kind === 'backlink') {
        table.views.push({ prop: n }); // named at the end, see below
      }
    }
    const names = new Set();
    for (const c of table.columns) {
      if (names.has(fold(c.name))) throw new Error(`${cls.name}: column name clash on "${c.name}"`);
      names.add(fold(c.name));
    }
    model.classes[cls.name] = table;
  }

  // Validate backlinks now that all classes are known.
  for (const t of Object.values(model.classes)) {
    for (const [n, d] of Object.entries(t.props)) {
      if (d.kind !== 'backlink') continue;
      const src = Object.hasOwn(model.classes, d.source) ? model.classes[d.source] : null;
      const sp = src && Object.hasOwn(src.props, d.sourceProp) ? src.props[d.sourceProp] : null;
      const ok = sp && ((sp.kind === 'link' && sp.target === t.name) || (sp.kind === 'list' && sp.elem.target === t.name) ||
        (sp.kind === 'json' && (sp.ctype === 'set' || sp.ctype === 'dictionary') && sp.elem.target === t.name));
      if (!ok) {
        warnings.push(`${t.name}.${n}: backlink origin ${d.source}.${d.sourceProp} not found; view skipped.`);
        delete t.props[n];
        t.views = t.views.filter((v) => v.prop !== n);
        t.skipped = { ...t.skipped, [n]: `a backlink whose origin ${d.source}.${d.sourceProp} is not a converted link` };
      } else {
        d.sourceKind = sp.kind === 'json' ? sp.ctype : sp.kind;
      }
    }
  }
  // Then indexes, then backlink views. Views come only from --schema, so naming
  // them last keeps every table and index name the same with or without it.
  for (const t of Object.values(model.classes)) {
    for (const l of t.lists) {
      if (l.columns.some((c) => c.name === 'target')) l.index = generated(t.name, l.prop, 'index', l.table + '__target');
    }
    for (const [n, d] of Object.entries(t.props)) {
      if (d.kind === 'link' || (d.kind === 'scalar' && d.indexed)) d.index = generated(t.name, n, 'index', t.table + '__' + n);
    }
  }
  for (const t of Object.values(model.classes)) {
    for (const v of t.views) v.view = t.props[v.prop].view = generated(t.name, v.prop, 'backlink view', `${t.table}__${v.prop}`);
  }
  model.renames = renames;
  for (const t of Object.values(model.classes)) {
    for (const [n, d] of Object.entries(t.props)) {
      if (d.kind === 'json') {
        const what = d.ctype === 'mixed' ? 'mixed' : d.ctype === 'list' ? 'list of mixed' : d.ctype;
        warnings.push(`${t.name}.${n}: ${what} stored as JSON text (not a relational table).`);
      }
    }
  }
  return { model, warnings };
}

function colDDL(c) {
  let s = `${q(c.name)} ${c.sql}`;
  if (c.pk) s += ' PRIMARY KEY';
  if (c.notNull) s += ' NOT NULL';
  if (c.unique) s += ' UNIQUE';
  if (c.check) s += ` CHECK (${c.check})`;
  if (c.fk) s += ` REFERENCES ${q(c.fk.table)}(${q(c.fk.column)}) ON DELETE ${c.fk.onDelete}`;
  return s;
}

/** DDL for tables (before load) and for indexes and views (after load). */
export function ddl(model) {
  const tables = [];
  const after = [];
  for (const t of Object.values(model.classes)) {
    const cols = t.columns.map(colDDL);
    tables.push(`CREATE TABLE ${q(t.table)} (\n  ${cols.join(',\n  ')}\n)${t.key.synthetic ? '' : ' WITHOUT ROWID'};`);
    for (const l of t.lists) {
      const cols = l.columns.map(colDDL);
      cols.push('PRIMARY KEY ("owner", "pos")');
      tables.push(`CREATE TABLE ${q(l.table)} (\n  ${cols.join(',\n  ')}\n) WITHOUT ROWID;`);
      if (l.index) after.push(`CREATE INDEX ${q(l.index)} ON ${q(l.table)}("target");`);
    }
    for (const d of Object.values(t.props)) {
      if (d.index) after.push(`CREATE INDEX ${q(d.index)} ON ${q(t.table)}(${q(d.column)});`);
    }
  }
  for (const t of Object.values(model.classes)) {
    for (const [n, d] of Object.entries(t.props)) {
      if (d.kind !== 'backlink') continue;
      const src = model.classes[d.source];
      const sp = src.props[d.sourceProp];
      const sk = q(src.key.column);
      let body;
      if (sp.kind === 'link') body = `SELECT ${q(sp.column)} AS owner, ${sk} AS source FROM ${q(src.table)} WHERE ${q(sp.column)} IS NOT NULL`;
      else if (sp.kind === 'list') body = `SELECT "target" AS owner, "owner" AS source FROM ${q(sp.table)}`;
      else body = `SELECT j.value AS owner, s.${sk} AS source FROM ${q(src.table)} s, json_each(s.${q(sp.column)}) j WHERE j.value IS NOT NULL`;
      after.push(`CREATE VIEW ${q(d.view)} AS ${body};`);
    }
  }
  after.push(`CREATE TABLE ${q(META_TABLE)} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL) WITHOUT ROWID;`);
  return { tables, after };
}
