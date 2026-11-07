// Differential test: each query runs on the SDK (Node) and, translated, on
// SQLite. Primary keys must match: same set, and same order with SORT (ties,
// whose order the query does not define, are compared as sets).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Realm from 'realm';
import Database from 'better-sqlite3';
import { convert } from '../src/convert.mjs';
import { translate, Unsupported } from '../src/rql.mjs';
import { mulberry32 } from '../src/verify.mjs';
import { tmpPath } from './fixtures.mjs';
import { makeRqlRealm, rqlSchema, NAMES, TAGS, CITIES, DATES } from './rql-fixture.mjs';

let realm, db, model;

before(async () => {
  const src = tmpPath('rql.realm');
  await makeRqlRealm(src);
  const out = tmpPath('rql.sqlite');
  const r = await convert(src, out, { schema: rqlSchema });
  assert.equal(r.ok, true);
  db = new Database(out, { readonly: true });
  model = JSON.parse(db.prepare(`SELECT value FROM _afterdb_meta WHERE key = 'model'`).pluck().get());
  realm = await Realm.open({ path: src, schema: rqlSchema, readOnly: true });
});
after(() => { db?.close(); realm?.close(); Realm.shutdown(); });

const P = (id) => realm.objectForPrimaryKey('Person', id);

// Sort-key tuple of an object, read from the SDK side (for tie handling).
function sortTuple(obj, sortPaths) {
  if (!obj) return '<missing object>';
  return JSON.stringify(sortPaths.map((segs) => {
    let v = obj;
    for (const s of segs) v = v === null || v === undefined ? null : v[s];
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : Object.is(v, -0) ? 0 : v === Infinity ? 'Inf' : v === -Infinity ? '-Inf' : v;
    return v ?? null;
  }));
}

const sameSet = (a, b) => a.length === b.length && JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

/** Same set; with SORT, same sort-key sequence and same members per tie group (except the group cut by LIMIT). */
function sameResult(realmIds, sqlIds, sortPaths, hasLimit) {
  if (!sortPaths.length) return sameSet(realmIds, sqlIds);
  const tr1 = realmIds.map((id) => sortTuple(id === null ? null : P(id), sortPaths));
  const tr2 = sqlIds.map((id) => sortTuple(P(id), sortPaths));
  if (JSON.stringify(tr1) !== JSON.stringify(tr2)) return false;
  const groups = (ids, tup) => { const g = []; ids.forEach((id, i) => { if (!i || tup[i] !== tup[i - 1]) g.push([]); g[g.length - 1].push(id); }); return g; };
  const g1 = groups(realmIds, tr1), g2 = groups(sqlIds, tr2);
  for (let i = 0; i < g1.length; i++) {
    if (hasLimit && i === g1.length - 1) break;
    if (!sameSet(g1[i], g2[i])) return false;
  }
  return true;
}

/** Runs one query on both sides. Returns {status, ...}. */
function runBoth(query, args = []) {
  let realmIds;
  try {
    realmIds = Array.from(realm.objects('Person').filtered(query, ...args), (o) => (o ? o._id : null));
  } catch (e) {
    realmIds = { error: e.message };
  }
  let tr, sqlIds;
  try {
    tr = translate(query, { model, className: 'Person', args });
    sqlIds = db.prepare(tr.sql).pluck().all(...tr.params);
  } catch (e) {
    sqlIds = { error: e.message, unsupported: e instanceof Unsupported };
  }
  if (realmIds.error && sqlIds.error) return { status: 'both-rejected', unsupported: sqlIds.unsupported, detail: sqlIds.error };
  if (realmIds.error) return { status: 'realm-rejected', detail: realmIds.error };
  if (sqlIds.error) return { status: sqlIds.unsupported ? 'unsupported' : 'translator-error', detail: sqlIds.error };

  const sortPaths = (() => {
    const m = /SORT\(([^)]*)\)/i.exec(query);
    return m ? m[1].split(',').map((x) => x.trim().split(/\s+/)[0].split('.')) : [];
  })();
  const hasLimit = /LIMIT\(/i.test(query);
  const strictOrder = JSON.stringify(realmIds) === JSON.stringify(sqlIds);
  const ok = sameResult(realmIds, sqlIds, sortPaths, hasLimit);
  if (ok) return { status: 'match', strictOrder, n: realmIds.length, warnings: tr.warnings };
  // Known categories are only assigned when the rest of the result agrees.
  let reason = 'mismatch';
  if (hasLimit && !sortPaths.length) {
    // Without LIMIT both sides must return the same set; with it, SQLite must
    // return a subset of that set of the same size as the SDK.
    const full = runBoth(query.replace(/\s*LIMIT\(\d+\)/gi, ''), args);
    const all = new Set(Array.from(realm.objects('Person').filtered(query.replace(/\s*LIMIT\(\d+\)/gi, ''), ...args), (o) => o._id));
    if (full.status === 'match' && sqlIds.length === realmIds.length && sqlIds.every((id) => all.has(id))) reason = 'mismatch-limit-without-sort';
  }
  if (realmIds.includes(null)) {
    const readable = realmIds.filter((id) => id !== null);
    if (sameResult(readable, sqlIds, sortPaths, hasLimit)) reason = 'mismatch-sdk-undefined-entries';
  }
  return { status: reason, realm: realmIds.slice(0, 12), realmN: realmIds.length, sqlite: sqlIds.slice(0, 12), sqliteN: sqlIds.length, sql: tr.sql, warnings: tr.warnings };
}

const D = DATES;
// [query, args?, known?] - "known" marks a documented, unreproducible difference.
const HANDWRITTEN = [
  // ints
  ['age == 20'], ['age != 20'], ['age > 30'], ['age >= 30'], ['age < 10'], ['age <= 0'], ['age == null'], ['age != null'], ['NOT age > 30'],
  ['_id > 250'], ['age > 12.5'], ['age IN {10, 20, 30}'], ['age IN {10, null}'], ['NOT age IN {10, 20}'], ['age == ANY {5, 15}'],
  // doubles / floats (NaN, -0, Infinity in data)
  ['height == 1.5'], ['height > 1.6'], ['height < 0'], ['height == 0'], ['height == -0'], ['height != 2'], ['height == null'], ['height != null'],
  ['height > 1e300'], ['height < -1e300'], ['NOT height > 1'], ['height >= 0 AND height <= 2'], ['height == $0', [Infinity]], ['height == $0', [NaN]], ['height != $0', [NaN]],
  ['score >= 2.5'], ['score == 1.25'], ['score == null'], ['height IN {1.5, 2}'],
  // strings
  ['name == "alice"'], ['name ==[c] "alice"'], ['name ==[c] "ÉMILE"'], ['name ==[c] "çağla"'], ['name ==[c] "STRASSE"'], ['name ==[c] "œuvre"'], ['name ==[c] "ÿves"'],
  ['name ==[c] "æsir"'], ['name ==[c] "øystein"'], ['name ==[c] "ñandú"'], ['name ==[c] "istanbul"'],
  ['name != "bob"'], ['name !=[c] "bob"'], ['name == ""'], ['name == null'], ['name != null'], ['name > "b"'], ['name <= "Bob"'],
  ['name BEGINSWITH "a"'], ['name BEGINSWITH[c] "A"'], ['name BEGINSWITH[c] "é"'], ['name BEGINSWITH ""'], ['name ENDSWITH "e"'], ['name ENDSWITH[c] "LE"'], ['name ENDSWITH ""'],
  ['name CONTAINS "li"'], ['name CONTAINS[c] "LI"'], ['name CONTAINS[c] "Ç"'], ['name CONTAINS ""'], ['name CONTAINS "🙂"'],
  ['name LIKE "a*"'], ['name LIKE "?lice"'], ['name LIKE[c] "*ICE"'], ['name LIKE "a?b"'], ['name LIKE "a[b]c"'], ['name LIKE "*"'], ['name LIKE "emoji ?"'], ['name LIKE[c] "é*"'],
  ['name IN {"alice", "bob", ""}'], ['name IN[c] {"ALICE", "émile"}'], ['nick BEGINSWITH name'], ['name == nick'], ['name != nick'],
  ['name.@size == 5'], ['name.@size > 6'],
  // bools
  ['active == true'], ['active == false'], ['active == null'], ['active != true'], ['NOT active == true'],
  // dates (some before 1970)
  ['born < $0', [D[2]]], ['born == $0', [D[0]]], ['born >= $0', [D[4]]], ['born == null'], ['born != $0', [D[1]]], ['born > $0 AND born < $1', [D[0], D[3]]],
  // AND / OR / NOT
  ['age > 20 AND active == true'], ['age < 10 OR name BEGINSWITH "a"'], ['NOT (age > 20 OR active == false)'], ['!(name == "bob") && age >= 25 || height == 2'],
  ['TRUEPREDICATE'], ['FALSEPREDICATE'], ['NOT TRUEPREDICATE'],
  // links
  ['city.name == "Paris"'], ['city.name ==[c] "paris"'], ['city.name ==[c] "ÉVRY"'], ['city.country == "FR"'], ['city.country == null'], ['city.name == null'], ['city == null'], ['city != null'],
  ['city.population > 2000'], ['boss.age > 30'], ['boss.name == null'], ['boss.boss.name == null'], ['boss.boss.age < 20'], ['boss == $0', ['P:5']], ['boss != $0', ['P:5']], ['city.mayor.age > 40'],
  ['NOT city.population > 2000'], ['boss._id IN {1, 2, 3, 4, 5}'], ['city.name IN {"Lyon", "Oslo"}'],
  // lists: @count / @size, ANY / ALL / NONE
  ['tags.@count == 0'], ['tags.@count > 2'], ['scores.@size >= 2'], ['friends.@count == 1'], ['visits.@count > 1'], ['ratings.@count == 0'],
  ['tags == "red"'], ['ANY tags == "red"'], ['ANY tags ==[c] "RED"'], ['ALL tags == "red"'], ['NONE tags == "red"'], ['ANY tags BEGINSWITH[c] "é"'], ['ALL tags CONTAINS "e"'],
  ['ANY scores > 5'], ['ALL scores > 5'], ['NONE scores > 5'], ['ANY scores == null'], ['NONE scores == null'], ['ALL scores != null'], ['ANY tags == null'], ['ANY tags IN {"red", "blue"}'],
  ['ANY ratings > 1'], ['ANY ratings == 0'], ['ALL ratings < 2'], ['ANY ratings == $0', [NaN]], ['ANY ratings > 1e300'],
  ['ANY friends.age > 40'], ['ALL friends.age > 20'], ['NONE friends.age > 20'], ['ANY friends.name ==[c] "alice"'], ['ANY friends.city.name == "Paris"'],
  ['ANY friends.city.name == null'], ['ALL friends.city.name == "Paris"'], ['NONE friends.city.name == "Paris"'], ['ANY friends.boss.name == null'], ['ALL friends.boss.age > 10'],
  ['ANY friends == $0', ['P:7']], ['ANY friends.tags == "red"'], ['ALL friends.tags == "red"'], ['friends.@count > 0 AND ALL friends.age >= 30'],
  ['ANY visits.place == "Lyon"'], ['ANY visits.stars == null'], ['ALL visits.stars >= 2'], ['ANY visits.at < $0', [D[2]]],
  ['ANY fans.age > 50'], ['fans.@count == 0'], ['reports.@count > 1'], ['ANY reports.name BEGINSWITH "a"'], ['ANY fans.city.name == "Lyon"'],
  ['boss.tags.@count > 1'], ['ANY boss.tags == "red"'], ['ANY boss.friends.age > 50'],
  // embedded
  ['address.street == "rue A"'], ['address.zip == null'], ['address == null'], ['address.floor > 2'], ['address.street BEGINSWITH[c] "RUE"'], ['address.floor IN {1, 2}'],
  // SORT / LIMIT
  ['TRUEPREDICATE SORT(age ASC)'], ['age > 10 SORT(age DESC)'], ['TRUEPREDICATE SORT(name ASC)'], ['TRUEPREDICATE SORT(height ASC)'], ['TRUEPREDICATE SORT(height DESC)'],
  ['TRUEPREDICATE SORT(born ASC, name DESC)'], ['TRUEPREDICATE SORT(active ASC, age DESC)'], ['TRUEPREDICATE SORT(city.name ASC)'], ['TRUEPREDICATE SORT(boss.age DESC, _id ASC)'],
  ['age > 10 SORT(age ASC) LIMIT(5)'], ['TRUEPREDICATE SORT(_id DESC) LIMIT(3)'], ['name CONTAINS "a" SORT(name ASC, _id ASC) LIMIT(10)'], ['TRUEPREDICATE SORT(score DESC) LIMIT(7)'],
  ['age > 10 SORT(age ASC) LIMIT(20) LIMIT(5)'], ['TRUEPREDICATE SORT(address.floor ASC)'], ['age > 10 LIMIT(0)'],
  ['age > 10 LIMIT(5)', [], 'LIMIT without SORT: SDK takes the first objects in insertion order, SQL in primary key order'],
  // IN + LIMIT quirk
  ['age IN {10, 20} LIMIT(3)'], ['_id IN {1, 2, 3, 4, 5} LIMIT(2)'], ['name IN {"alice", "bob"} SORT(_id ASC) LIMIT(2)'], ['age IN {10, 20} AND TRUEPREDICATE SORT(_id ASC) LIMIT(3)'],
  ['_id IN {1, 2, 3, 4, 5} SORT(_id ASC) LIMIT(2)', [], 'SDK quirk: reports 5 objects, only 2 readable'],
  // [c] with an array argument: ignored by == on a base string (quirk), kept by !=, through a link, with the value on the left
  ['name ==[c] $0', [['alice']]], ['nick ==[c] $0', [['alice']]], ['name ==[c] $0', [['alice', 'BOB']]], ['NOT name ==[c] $0', [['alice']]], ['name ==[c] $0', [[null, 'émile']]],
  ['name !=[c] $0', [['alice']]], ['city.name ==[c] $0', [['paris', 'LYON']]], ['$0 ==[c] name', [['alice']]],
  // [c] on a link with == ANY {...}: ignored on the base object
  ['boss ==[c] ANY {$0}', ['P:5']], ['friends ==[c] ANY {$0}', ['P:7']],
  // backlinks compared with an object, where the SDK gives the element test
  ['ALL fans == $0', ['P:3']], ['NONE fans == $0', ['P:3']], ['ALL fans != $0', ['P:3']], ['NONE reports == $0', ['P:5']], ['ALL fans == ANY {$0}', ['P:3']],
  ['ANY friends.fans == $0', ['P:3']], ['boss.fans == $0', ['P:3']], ['$0 == fans', ['P:3']], ['$0 != reports', ['P:5']], ['ANY fans IN {$0}', ['P:3']],
  ['fans == boss'], ['ANY reports == boss'], ['ALL fans == boss'],
  // a list of objects, then a to-one link at the end, compared with an object or
  // a link: the SDK drops the elements whose last link is null
  ['friends.boss != $0', ['P:275']], ['ANY friends.boss != $0', ['P:275']], ['ALL friends.boss == $0', ['P:275']], ['ANY fans.boss != $0', ['P:275']],
  ['ALL fans.boss == $0', ['P:275']], ['NONE fans.boss != $0', ['P:275']], ['fans.boss != $0', ['P:275']], ['ALL friends.boss == ANY {$0}', ['P:275']],
  ['friends.city != $0', ['C:Lyon']], ['ALL friends.city == $0', ['C:Lyon']], ['fans.city != $0', ['C:Lyon']], ['ALL fans.city == $0', ['C:Lyon']],
  ['ANY friends.boss == boss'], ['ANY friends.boss != boss'], ['ALL friends.boss == boss'], ['friends.city != city'], ['NONE friends.boss == boss'], ['NONE friends.city != city'],
  ['ALL friends.boss.boss == $0', ['P:275']], ['ALL friends.city.mayor == $0', ['P:275']], ['ANY boss.friends.boss != $0', ['P:275']], ['ALL friends.boss == boss.boss'],
  ['friends.boss == $0', ['P:275']], ['NONE friends.boss == $0', ['P:275']], ['ALL friends.boss != $0', ['P:275']], ['ANY friends.boss IN {$0, $1}', ['P:275', 'P:1']],
  ['ANY friends.boss IN {null, $0}', ['P:275']], ['ALL friends.boss IN {null, $0}', ['P:275']], ['ANY friends.boss IN {null, null}'], ['ALL friends.boss IN {}'], ['ANY friends IN {null, $0}', ['P:275']],
  ['friends.age IN {5}'], ['friends IN {$0}', ['P:275']],
];

// 'P:<id>' is a Person, 'C:<name>' a City (inside an array argument too).
function resolveArgs(args = []) {
  return args.map((a) => (Array.isArray(a) ? resolveArgs(a) : typeof a !== 'string' ? a
    : a.startsWith('P:') ? P(Number(a.slice(2))) : a.startsWith('C:') ? realm.objectForPrimaryKey('City', a.slice(2)) : a));
}

test('handwritten queries', () => {
  const tally = {};
  const bad = [];
  let known = 0;
  for (const [query, args, why] of HANDWRITTEN) {
    const r = runBoth(query, resolveArgs(args));
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    if (r.status.startsWith('mismatch') || r.status === 'translator-error' || r.status === 'unsupported' || r.status === 'realm-rejected') {
      if (why) known++;
      else bad.push({ query, ...r });
    } else if (why) {
      bad.push({ query, note: 'marked as known difference but matches', ...r });
    }
  }
  const mism = Object.entries(tally).filter(([k]) => k.startsWith('mismatch')).reduce((s, [, v]) => s + v, 0);
  console.log(`handwritten: ${HANDWRITTEN.length} queries, ${mism} mismatches (${known} known and documented), tally ${JSON.stringify(tally)}`);
  for (const b of bad) console.log('UNEXPECTED', JSON.stringify(b));
  assert.equal(bad.length, 0);
});

// Error classes: Unsupported means "run it with the SDK"; another RqlError
// means the SDK refuses the query too (see README, Query translation).
const SDK_ANSWERS = [
  ['born == T0:0'], ['born == 1970-01-01@00:00:00'], ['_id == 1.0f'], ['name == B64"YWxpY2U="'], ['tags[FIRST] == "red"'], ['age == ANY scores'],
  ['@links.Person.friends.@count > 0'], ['ANY @links.Person.boss._id == 5'],
  ['ALL friends.@count > 0'], ['ANY tags.@count == 1'], ['NONE tags.@count == 0'], ['boss.@count == 1'], ['address.@count == 1'],
  ['age IN {$0}', [[1, 2]]], ['tags IN {$0}', [['red']]], ['name ==[c] $0', [['alice', 5]]],
  // the SDK does not give the element test here (README, Known limits)
  ['ANY fans == $0', ['P:3']], ['fans == $0', ['P:3']], ['fans != $0', ['P:3']], ['fans == ANY {$0}', ['P:3']], ['ANY reports == $0', ['P:5']],
  // "list IN {...}" without ANY through a link after the list (README, Known limits)
  ['friends.boss IN {$0}', ['P:275']], ['friends.city IN {$0}', ['C:Lyon']], ['friends.boss IN {}'], ['friends.city.name IN {"Lyon"}'], ['friends.boss.age IN {5}'],
];
const SDK_REFUSES = [
  ['fans == $0', [null]], ['boss IN[c] {$0}', ['P:5']], ['boss.boss ==[c] ANY {$0}', ['P:5']], ['age.@count == 1'], ['@count == 1'], ['ANY name == "alice"'],
  ['TRUEPREDICATE SORT(tags.@count ASC)'], ['address == $0', ['P:3']], ['name CONTAINS 5'], ['boss < $0', ['P:1']], ['age == $1', [1]],
  // [c] on a list of links with ALL or NONE (ANY is answered)
  ['ALL friends ==[c] $0', ['P:275']], ['NONE friends ==[c] $0', ['P:275']], ['ALL fans ==[c] $0', ['P:275']], ['NONE reports ==[c] $0', ['P:275']],
  ['ALL friends !=[c] $0', ['P:275']], ['ALL friends ==[c] ANY {$0}', ['P:275']], ['ALL friends ==[c] $0', [['P:275']]],
  // a list of links compared with a single null in IN or == ANY
  ['ANY friends.boss IN {null}'], ['ANY friends.boss IN $0', [[null]]], ['ANY friends.boss == ANY {null}'], ['ALL friends.city IN {null}'], ['ANY friends IN {null}'], ['friends.boss IN {null}'],
];

test('error classes: Unsupported where the SDK answers, RqlError where it refuses', () => {
  const bad = [];
  for (const [query, args] of SDK_ANSWERS) {
    const r = runBoth(query, resolveArgs(args));
    if (r.status !== 'unsupported') bad.push({ query, expected: 'unsupported', ...r });
  }
  for (const [query, args] of SDK_REFUSES) {
    const r = runBoth(query, resolveArgs(args));
    if (r.status !== 'both-rejected' || r.unsupported) bad.push({ query, expected: 'both-rejected with RqlError', ...r });
  }
  for (const b of bad) console.log('UNEXPECTED', JSON.stringify(b));
  assert.equal(bad.length, 0);
});

// ---------- fuzzer ----------

const LEAVES = {
  int: ['age', '_id', 'city.population', 'boss.age', 'address.floor', 'boss.boss.age', 'city.mayor.age'],
  intList: ['scores', 'friends.age', 'visits.stars', 'fans.age', 'reports.age', 'friends.scores'],
  double: ['height', 'boss.height', 'score'],
  doubleList: ['ratings', 'friends.height'],
  string: ['name', 'nick', 'city.name', 'city.country', 'boss.name', 'address.street', 'address.zip'],
  stringList: ['tags', 'friends.name', 'visits.place', 'friends.city.name', 'fans.nick', 'friends.tags'],
  bool: ['active', 'boss.active'],
  date: ['born', 'boss.born'],
  dateList: ['visits.at', 'friends.born'],
  count: ['tags.@count', 'friends.@count', 'scores.@size', 'fans.@count', 'reports.@count', 'visits.@count', 'name.@size', 'boss.friends.@count'],
};
const SORTABLE = ['age', 'name', 'height', 'score', 'born', 'active', 'city.name', 'boss.age', '_id', 'nick', 'address.floor'];

function fuzzQueries(count, seed) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const str = (s) => JSON.stringify(s);
  const numCmp = () => pick(['==', '!=', '<', '<=', '>', '>=']);
  const intVal = () => (chance(0.1) ? 'null' : String(pick([0, 5, 10, 15, 20, 25, 30, 40, 55, 1000, 2000, -1, 3, 150])));
  const dblVal = () => (chance(0.1) ? 'null' : pick(['0', '-0', '1.5', '1.75', '2', '1e-300', '1e300', '-1e300', '0.5', '2.5', '1.25']));
  const strVal = () => (chance(0.08) ? 'null' : str(pick([...NAMES, ...TAGS.filter((x) => x !== null), ...CITIES, 'FR', 'CH', 'rue A', '75001', 'a', 'é', 'É', 'ç', 'li', 'e', 'RE'])));
  const quant = () => (chance(0.5) ? '' : pick(['ANY ', 'ALL ', 'NONE ']));
  function leaf(args) {
    const kind = pick(['int', 'intList', 'double', 'doubleList', 'string', 'stringList', 'string', 'bool', 'date', 'dateList', 'count', 'link', 'in']);
    switch (kind) {
      case 'int': return `${pick(LEAVES.int)} ${numCmp()} ${intVal()}`;
      case 'intList': return `${quant()}${pick(LEAVES.intList)} ${numCmp()} ${intVal()}`;
      case 'double': return `${pick(LEAVES.double)} ${numCmp()} ${dblVal()}`;
      case 'doubleList': return `${quant()}${pick(LEAVES.doubleList)} ${numCmp()} ${dblVal()}`;
      case 'string': case 'stringList': {
        const path = kind === 'string' ? pick(LEAVES.string) : quant() + pick(LEAVES.stringList);
        const op = pick(['==', '!=', 'BEGINSWITH', 'ENDSWITH', 'CONTAINS', 'LIKE', '==', '>', '<']);
        const ci = chance(0.4) && !['>', '<'].includes(op) ? '[c]' : '';
        let v = strVal();
        if (op === 'LIKE' && v !== 'null') v = str(pick(['a*', '*e', '?lice', '*é*', 'É*', '*', 'a?b', 'r?d', '*🙂']));
        return `${path} ${op}${ci} ${v}`;
      }
      case 'bool': return `${pick(LEAVES.bool)} ${pick(['==', '!='])} ${pick(['true', 'false', 'null'])}`;
      case 'date': case 'dateList': {
        args.push(pick(DATES));
        const path = kind === 'date' ? pick(LEAVES.date) : quant() + pick(LEAVES.dateList);
        return `${path} ${numCmp()} $${args.length - 1}`;
      }
      case 'count': return `${pick(LEAVES.count)} ${numCmp()} ${pick([0, 1, 2, 3, 5])}`;
      case 'link': {
        const path = pick(['boss', 'city', 'city.mayor', 'boss.boss']);
        if (chance(0.4)) return `${path} ${pick(['==', '!='])} null`;
        args.push(path.startsWith('city') && path === 'city' ? realm.objectForPrimaryKey('City', pick(CITIES)) : P(1 + Math.floor(rnd() * 300)));
        return `${path} ${pick(['==', '!='])} $${args.length - 1}`;
      }
      default: {
        const path = pick(['age', 'name', 'city.name', 'tags', 'scores', 'boss.age']);
        const vals = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => (/age|scores/.test(path) ? intVal() : strVal()));
        const q0 = /tags|scores/.test(path) ? quant() : '';
        return `${q0}${path} IN${chance(0.2) && !/age|scores/.test(path) ? '[c]' : ''} {${vals.join(', ')}}`;
      }
    }
  }
  function expr(depth, args) {
    if (depth <= 0 || chance(0.4)) return chance(0.15) ? `NOT ${leaf(args)}` : leaf(args);
    const r = rnd();
    if (r < 0.4) return `${expr(depth - 1, args)} AND ${expr(depth - 1, args)}`;
    if (r < 0.75) return `(${expr(depth - 1, args)} OR ${expr(depth - 1, args)})`;
    return `NOT (${expr(depth - 1, args)})`;
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const args = [];
    let query = expr(3, args);
    if (chance(0.35)) {
      const keys = [pick(SORTABLE), ...(chance(0.4) ? [pick(SORTABLE)] : [])];
      query += ` SORT(${[...new Set(keys)].map((k) => `${k} ${pick(['ASC', 'DESC'])}`).join(', ')})`;
      if (chance(0.5)) query += ` LIMIT(${1 + Math.floor(rnd() * 40)})`;
    } else if (chance(0.1)) {
      query += ` LIMIT(${1 + Math.floor(rnd() * 40)})`;
    }
    out.push([query, args]);
  }
  return out;
}

const FUZZ_N = Number(process.env.AFTERDB_FUZZ_N ?? 200);
const FUZZ_SEED = Number(process.env.AFTERDB_FUZZ_SEED ?? 42);

test(`fuzz: ${FUZZ_N} random queries (seed ${FUZZ_SEED})`, () => {
  const tally = {};
  const examples = {};
  for (const [query, args] of fuzzQueries(FUZZ_N, FUZZ_SEED)) {
    const r = runBoth(query, args);
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    (examples[r.status] ??= []).push({ query, ...r });
  }
  const mism = Object.entries(tally).filter(([k]) => k.startsWith('mismatch')).reduce((s, [, v]) => s + v, 0);
  const matched = examples.match ?? [];
  const sizes = { empty: matched.filter((m) => m.n === 0).length, all: matched.filter((m) => m.n === 300).length };
  const sortedMatches = matched.filter((m) => m.strictOrder !== undefined && /SORT\(/.test(m.query));
  console.log(`fuzz: ${FUZZ_N} queries (seed ${FUZZ_SEED}), ${mism} mismatches, tally ${JSON.stringify(tally)}; ` +
    `matches returning 0 rows: ${sizes.empty}, all 300 rows: ${sizes.all}; sorted matches with identical order including ties: ${sortedMatches.filter((m) => m.strictOrder).length}/${sortedMatches.length}`);
  for (const [k, list] of Object.entries(examples)) {
    if (k === 'match') continue;
    for (const e of list.slice(0, 6)) console.log(k.toUpperCase(), JSON.stringify(e).slice(0, 700));
  }
  // Unexplained mismatches fail the test; the known category is reported above.
  assert.equal(tally.mismatch ?? 0, 0);
  assert.equal(tally['translator-error'] ?? 0, 0);
});

test('quirks: false gives plain semantics', () => {
  const plain = translate('age IN {10, 20} LIMIT(3)', { model, className: 'Person', quirks: false });
  assert.equal(db.prepare(plain.sql).pluck().all(...plain.params).length, 3);
  const sdk = translate('age IN {10, 20} LIMIT(3)', { model, className: 'Person' });
  assert.equal(db.prepare(sdk.sql).pluck().all(...sdk.params).length, realm.objects('Person').filtered('age IN {10, 20} LIMIT(3)').length);
});
