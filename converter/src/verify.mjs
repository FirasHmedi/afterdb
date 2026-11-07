// Verification of a converted file against the open source database.
import Realm from 'realm';
import { canonRealm, canonRealmField, canonSql, sqlReaders, stable, sha256, cmpKey, backlinkIndex } from './canon.mjs';
import { q, isFloat } from './model.mjs';
import { relax, due, pause } from './gc.mjs';

const MAX_LISTED = 100;
const PAGE = 1000;
const SPECIAL = new Set(['NaN', '-0', 'Infinity', '-Infinity']);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function realmPk(type, v) {
  if (type === 'objectId') return new Realm.BSON.ObjectId(v);
  if (type === 'uuid') return new Realm.BSON.UUID(v);
  return v;
}

function diffFields(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => stable(a?.[k]) !== stable(b?.[k]));
}

function countSpecials(model, t, canon) {
  let n = 0;
  for (const [p, d] of Object.entries(t.props)) {
    if (d.kind === 'scalar' && isFloat(d.type) && SPECIAL.has(canon[p])) n++;
    if (d.kind === 'list' && isFloat(d.elem.type)) n += canon[p].filter((v) => SPECIAL.has(v)).length;
  }
  return n;
}

/** Every class and property stored in the file must be in the model. */
function schemaCheck(fileSchema, model) {
  const missing = [];
  for (const c of fileSchema) {
    if (c.asymmetric) continue;
    const props = c.embedded ? model.embedded[c.name]?.props : model.classes[c.name]?.props;
    if (!props) { missing.push(c.name); continue; }
    for (const p of Object.keys(c.properties)) if (!Object.hasOwn(props, p)) missing.push(`${c.name}.${p}`);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * @param realm the source, opened without a schema (so realm.schema is the file's)
 * @returns verification result (plain JSON). `ok` is true when every check passes.
 */
export async function verify(realm, db, model, { sample = 300, seed = 1 } = {}) {
  const out = { tables: [], lists: [], views: [], digests: [], mismatchCount: 0, mismatches: [], lossy: { realm: 0, sqlite: 0 } };
  const listMismatch = (m) => { out.mismatchCount++; if (out.mismatches.length < MAX_LISTED) out.mismatches.push(m); };
  out.schemaCheck = schemaCheck(realm.schema, model);
  const backlinks = await backlinkIndex(realm, model);

  for (const t of Object.values(model.classes)) {
    const kc = t.key.synthetic ? '_rid' : t.key.column;
    const results = realm.objects(t.name);
    const expected = new Map(); // stable(key) -> hash
    const listExpected = Object.fromEntries(t.lists.map((l) => [l.prop, 0]));
    const viewExpected = Object.fromEntries(t.views.map((v) => [v.prop, 0]));
    const realmEntries = [];
    for (let i = 0; i < results.length; i++) {
      const c = canonRealm(model, t.name, results[i], backlinks);
      const k = stable(c[kc]);
      const h = sha256(stable(c));
      expected.set(k, h);
      realmEntries.push(k + ':' + h);
      for (const l of t.lists) listExpected[l.prop] += c[l.prop].length;
      for (const v of t.views) viewExpected[v.prop] += c[v.prop].length;
      out.lossy.realm += countSpecials(model, t, c);
      if (i % 10000 === 9999) await relax();
      else if (due()) await pause();
    }

    // SQLite side, paged by key so other statements can run in between.
    const readers = sqlReaders(db, model, t.name);
    const first = db.prepare(`SELECT * FROM ${q(t.table)} ORDER BY ${q(kc)} LIMIT ${PAGE}`);
    const next = db.prepare(`SELECT * FROM ${q(t.table)} WHERE ${q(kc)} > ? ORDER BY ${q(kc)} LIMIT ${PAGE}`);
    const sqlEntries = [];
    let rows = 0;
    let page = first.all();
    while (page.length) {
      for (const row of page) {
        rows++;
        const c = canonSql(model, t.name, row, readers);
        const k = stable(c[kc]);
        const h = sha256(stable(c));
        sqlEntries.push(k + ':' + h);
        out.lossy.sqlite += countSpecials(model, t, c);
        const e = expected.get(k);
        if (e === undefined) listMismatch({ class: t.name, key: c[kc], reason: 'row not in source' });
        else if (e !== h) {
          const src = lookup(realm, t, c[kc]);
          const fields = src ? diffFields(canonRealm(model, t.name, src, backlinks), c) : [];
          listMismatch({ class: t.name, key: c[kc], reason: 'hash differs', fields });
        }
        expected.delete(k);
        if (due()) await pause();
      }
      page = page.length < PAGE ? [] : next.all(page[page.length - 1][kc]);
      if (rows % 10000 === 0) await relax();
    }
    for (const k of expected.keys()) listMismatch({ class: t.name, key: JSON.parse(k), reason: 'object missing in SQLite' });

    const realmDigest = sha256(realmEntries.sort().join('\n'));
    const sqlDigest = sha256(sqlEntries.sort().join('\n'));
    out.tables.push({ class: t.name, table: t.table, objects: results.length, rows, ok: rows === results.length });
    out.digests.push({ class: t.name, source: realmDigest, sqlite: sqlDigest, equal: realmDigest === sqlDigest });
    for (const l of t.lists) {
      const n = db.prepare(`SELECT count(*) FROM ${q(l.table)}`).pluck().get();
      out.lists.push({ table: l.table, expected: listExpected[l.prop], rows: n, ok: n === listExpected[l.prop] });
    }
    for (const v of t.views) {
      const d = t.props[v.prop];
      const n = db.prepare(`SELECT count(*) FROM ${q(d.view)}`).pluck().get();
      out.views.push({ view: d.view, expected: viewExpected[v.prop], rows: n, ok: n === viewExpected[v.prop] });
    }
  }

  await pause();
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  out.foreignKeyCheck = { violations: fk.length, first: fk.slice(0, 10) };
  await pause();
  out.integrityCheck = db.prepare('PRAGMA integrity_check').pluck().all().join('; ');
  out.sample = await sampleCheck(realm, db, model, sample, seed, backlinks);

  out.ok = out.schemaCheck.ok && out.tables.every((x) => x.ok) && out.lists.every((x) => x.ok) && out.views.every((x) => x.ok) &&
    out.digests.every((x) => x.equal) && out.mismatchCount === 0 && fk.length === 0 &&
    out.integrityCheck === 'ok' && out.sample.mismatchCount === 0 && out.lossy.realm === out.lossy.sqlite;
  return out;
}

function lookup(realm, t, key) {
  if (t.key.synthetic) return realm._objectForObjectKey(t.name, String(key)) ?? null;
  return realm.objectForPrimaryKey(t.name, realmPk(t.key.type, key));
}

/** Random rows read from SQLite, looked up by key in the source, compared field by field. */
async function sampleCheck(realm, db, model, size, seed, backlinks) {
  const rnd = mulberry32(seed);
  const res = { requested: size, objects: 0, fields: 0, mismatchCount: 0, mismatches: [] };
  const tables = Object.values(model.classes);
  const keysBy = tables.map((t) => db.prepare(`SELECT ${q(t.key.synthetic ? '_rid' : t.key.column)} FROM ${q(t.table)}`).pluck().all());
  const total = keysBy.reduce((s, k) => s + k.length, 0);
  if (!total || !size) return res;
  for (const [i, t] of tables.entries()) {
    const keys = keysBy[i];
    if (!keys.length) continue;
    const kc = t.key.synthetic ? '_rid' : t.key.column;
    const want = Math.min(keys.length, Math.max(1, Math.round((size * keys.length) / total)));
    // Partial Fisher-Yates for distinct picks.
    for (let j = 0; j < want; j++) {
      const r = j + Math.floor(rnd() * (keys.length - j));
      [keys[j], keys[r]] = [keys[r], keys[j]];
    }
    const byKey = db.prepare(`SELECT * FROM ${q(t.table)} WHERE ${q(kc)} = ?`);
    const readers = sqlReaders(db, model, t.name);
    for (const k of keys.slice(0, want)) {
      const row = byKey.get(k);
      const c = canonSql(model, t.name, row, readers);
      const src = lookup(realm, t, c[kc]);
      res.objects++;
      if (!src) {
        res.mismatchCount++;
        res.mismatches.push({ class: t.name, key: c[kc], field: null, reason: 'not found in source' });
        continue;
      }
      if (res.objects % 1000 === 0) await relax();
      else if (due()) await pause();
      for (const p of Object.keys(t.props)) {
        res.fields++;
        const a = stable(canonRealmField(model, t.name, src, p, backlinks));
        const b = stable(c[p]);
        if (a !== b) {
          res.mismatchCount++;
          if (res.mismatches.length < MAX_LISTED) res.mismatches.push({ class: t.name, key: c[kc], field: p, source: a.slice(0, 200), sqlite: b.slice(0, 200) });
        }
      }
    }
  }
  return res;
}

export { cmpKey };
