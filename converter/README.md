# @keelstore/converter

`keel-convert` reads a local object database file (the `.realm` format used by
React Native apps) and writes an equivalent SQLite database. Then it checks the
result against the source and writes a report. The source file is opened
read-only and its SHA-256 is compared before and after.

Private package, not published. Node 22+, ESM, no build step.

```
npm install
npx keel-convert app.realm app.sqlite [--key <128 hex>] [--schema schema.mjs] [--report out/]
```

| option | |
|---|---|
| `--key` | encryption key of the source (64 bytes as 128 hex characters; also read from `KEEL_KEY`) |
| `--schema` | the app's JS schema module (`export const schema = [...]` or a default export). Needed for backlinks, which are not stored in the file |
| `--report <dir>` | writes `report.json` and `report.md` |
| `--sample <n>` | size of the field-by-field random sample (default 300) |
| `--batch <n>` | objects per transaction (default 1000) |
| `--force` | overwrite the output |

Exit code: 0 verified, 2 verification failed, 1 error. The output is written to
`<out>.partial` and renamed at the end.

API: `convert(input, output, opts)`, `verifyFile(input, sqlite, opts)` (src/convert.mjs),
`translate(query, { model, className, args, quirks })` (src/rql.mjs). The mapping
model is stored in the output, in table `_keel_meta` (key `model`).

## Mapping

| source | SQLite |
|---|---|
| class with primary key | table `Class`, `WITHOUT ROWID`, PK column keeps its name |
| class without primary key (or optional PK) | rowid table with `_rid INTEGER PRIMARY KEY` = the SDK object key; an optional PK stays as a `UNIQUE` column |
| `int`, `counter` | `INTEGER` |
| `bool` | `INTEGER CHECK (x IN (0,1))` |
| `double`, `float` | `REAL` + companion column `x__x TEXT` (see below) |
| `string` | `TEXT` |
| `data` | `BLOB` |
| `date` | `INTEGER`, milliseconds since 1970 (negative before) |
| `decimal128` | `TEXT`, exact string (`1.10`, `-0`, `NaN`, `9.99…E+6144`) |
| `objectId` | `TEXT`, 24 hex lowercase |
| `uuid` | `TEXT`, canonical lowercase with dashes |
| link `T?` | column of the target key type, `REFERENCES T(key) ON DELETE SET NULL` |
| list of values `T[]` | table `Class__prop(owner, pos, value [, value__x])`, PK `(owner, pos)` |
| list of objects | table `Class__prop(owner, pos, target)`, FKs `ON DELETE CASCADE`, index on `target` |
| embedded object / list of embedded | `TEXT CHECK (json_valid(x))`: JSON object / array |
| backlink (`linkingObjects`) | view `Class__prop(owner, source)` |
| `set`, `dictionary`, `mixed`, list of `mixed` | JSON text with a warning in the report |
| asymmetric class | skipped, with a warning |

Indexed properties and link columns get an index. Mixed values are tagged JSON
(`{"t":"date","v":-1000}`); links in JSON hold the target key. In JSON, data is
base64, dates are milliseconds, special doubles are strings.

### NaN, -0 and Infinity

SQLite turns NaN into NULL and stores -0.0 as 0, silently. Infinity survives in a
`REAL`. Each double/float column (and each `value` column of a list of doubles)
therefore has a companion `TEXT` column named `<column>__x`:

| value | `x` | `x__x` |
|---|---|---|
| NaN | NULL | `'NaN'` |
| -0 | 0 | `'-0'` |
| null | NULL | NULL |
| anything else, ±Infinity included | the value | NULL |

So `x IS NULL AND x__x IS NULL` is the real null test. A non-optional double has
`CHECK (x IS NOT NULL OR x__x = 'NaN')`. Inside JSON, NaN, -0 and ±Infinity are
the strings `"NaN"`, `"-0"`, `"Infinity"`, `"-Infinity"`. Tests check that every
such value is read back from SQLite (`lossy` counts in the report).

Note: the SDK itself returns +0 for a -0 written to a double *property*
(lists and mixed keep -0), so `-0` only shows up in list tables and JSON.

## Verification (src/verify.mjs)

Runs after each conversion, results in the report:

- object count per class vs row count; element count per list vs list table rows; backlink count vs view rows;
- `PRAGMA foreign_key_check` (must be empty) and `PRAGMA integrity_check`;
- per-object SHA-256 of a canonical serialization (sorted keys, normalized types),
  computed from both sides by two independent readers (src/canon.mjs, which does
  not reuse the write code), plus a per-table digest. Missing, extra and different
  objects are listed with the differing fields;
- a random sample (default 300, seeded): rows are picked in SQLite, looked up in
  the source by key, and compared field by field;
- NaN / -0 / ±Infinity counted on both sides.

The test `verification detects tampering` changes a value, drops a NaN, deletes a
list element and a row, and checks that each check reports it.

Memory: the SDK frees native memory through finalizers that only run on the
event loop. Conversion and verification yield and force a GC every 10 000
objects (src/gc.mjs); without it RSS grew to 2.9 GB for 200 000 objects.

## Query translation (src/rql.mjs)

Translates a subset of the query language to SQL over the generated schema:
comparisons on int/double/float/string/bool/date, `AND/OR/NOT`, `BEGINSWITH`,
`ENDSWITH`, `CONTAINS`, `LIKE` (with `[c]`), `IN {…}` and `== ANY {…}`, key
paths through links, lists, backlinks and embedded objects, `@count`/`@size`,
`ANY/SOME/ALL/NONE`, `SORT`, `LIMIT`, `TRUEPREDICATE`, `$n` arguments (SDK
objects are accepted as arguments for links). Each comparison compiles to a
two-valued SQL expression (never NULL), so `NOT` behaves like the SDK.

With `SORT`, ties are ordered by primary key (the SDK uses insertion order).
Without `SORT`, rows come in primary key order (the SDK uses insertion order).

### SDK behaviours reproduced

All measured on realm 20.2.0 with the differential test. Rows marked *quirk* are
reproduced only when `quirks: true` (the default); `quirks: false` gives the plain
meaning.

| behaviour | what the SDK does |
|---|---|
| `[c]` | folds ASCII and Latin-1 `À`–`Þ` only (`É`=`é`, `Ç`=`ç`; `Œ`≠`œ`, `Ÿ`≠`ÿ`, `ß`≠`SS`, `İ`≠`i`). SQLite `lower()` folds ASCII only and JS `toLowerCase()` folds too much; we emit `lower()` over 30 `replace()` calls |
| string ordering, `LIKE` | byte order (= SQLite `BINARY`); `LIKE` uses `*` and `?` (one code point), `[` is literal (we use `GLOB` with `[` escaped) |
| `@size` on a string | length in UTF-8 bytes |
| null through links | `boss.name == null` is true when `boss` is null (LEFT JOIN) |
| null inside lists | a null link inside a list path drops the element: `ANY friends.city.name == null` is false for a friend without city (inner JOIN) |
| `ALL`/`NONE` over two lists | `ALL friends.tags == x` = no friends, or at least one friend whose tags all equal x (the quantifier applies to the last list, the first one is ANY) |
| `@count` through a null link | every comparison is false, `!=` included |
| SORT through a null link / null embedded | those objects sort after all values (before with DESC); null values sort first |
| SORT on doubles | null < NaN < -Infinity < … |
| NaN on a base property | IEEE: every comparison false except `!=` |
| NaN in a list or through a link | NaN is below every number and `NaN == NaN` |
| float property | the compared value is rounded to float first (`score >= 1e-300` is `score >= 0`) |
| comparisons with `null` | `<= null`/`>= null` are `== null`; `< null`/`> null` are false; `LIKE null` is `== null`; `CONTAINS null` means "not null"; `BEGINSWITH`/`ENDSWITH null` are false |
| *quirk* string property of the base class | null is below every string: `name < "b"` includes nulls, `name >= null` is always true, `CONTAINS/BEGINSWITH/ENDSWITH null` are always true |
| *quirk* integer literal vs double property | NaN counts as below every number (`height < 0` includes NaN, `height < 0.0` does not) |
| *quirk* `list IN {a, b}` without ANY | true when the whole list equals `[a, b]`, in order (`ANY list IN {…}` is the element test) |
| *quirk* `IN[c]` on a base property | `[c]` is ignored (honoured through links, lists and embedded objects) |
| *quirk* `IN {ints}` on a base double/float property | integer literals never match; a list of integers only matches every object |
| *quirk* `<int property> IN {…} LIMIT(n)` as the whole predicate | LIMIT is ignored. With SORT, `length` reports the unlimited count but entries after n read as `undefined` (not reproducible; SQL applies LIMIT) |
| *quirk* dates before 1970 with milliseconds | the JS SDK stores `Date(-1)` as -1001 ms (floor of seconds plus a negative remainder); query arguments get the same treatment, so the translator applies it to Date arguments |

The converter stores the date the SDK reads back (-1001 for a `Date(-1)` written
by the app). It cannot know the value the app meant.

### Differential test (test/diff.test.mjs)

300 fictitious people (unicode names, ties, nulls, NaN/±Infinity/-0 heights,
dates before 1970, links, lists, a class without PK, backlinks, embedded),
inserted in shuffled order. Each query runs on the SDK and on SQLite; primary
keys are compared as a set, and with `SORT` as a sequence where members of a tie
group may come in any order (the group cut by `LIMIT` is compared by size).

Measured on darwin arm64, Node 22.19.0:

- **196 handwritten queries: 2 mismatches**, both known and listed above:
  `age > 10 LIMIT(5)` (LIMIT without SORT picks different objects) and
  `_id IN {…} SORT(_id ASC) LIMIT(2)` (SDK returns `undefined` entries).
- **fuzz 200 (seed 42, run by `npm test`): 12 mismatches**, all "LIMIT without
  SORT": the same query without LIMIT returns the same set on both sides.
  0 unexplained. 41 matching queries returned 0 rows, 18 returned all 300.
- Extra runs, 1000 queries each (`KEEL_FUZZ_N=1000 KEEL_FUZZ_SEED=n`): seeds 1–5
  give 35, 51, 46, 55, 63 mismatches: 248 "LIMIT without SORT", 2 "undefined
  entries", 0 unexplained.
- With SORT, the exact order (ties included) matched in 20 of 62 sorted queries
  (seed 42); the others differ only inside tie groups.

The test fails on any unexplained mismatch or translator error.

## Tests

`npm test` (about 5 s): conversion of every type and edge value (NaN, -0,
±Infinity, empty strings, É/Ç/ß/emoji, NFD, NUL character, 100 000-character
string, dates before 1970, max decimal128), with and without app schema,
encrypted source, tamper detection, CLI, differential queries, scale.

Figures (darwin arm64, Node 22.19.0):

| test | result |
|---|---|
| `npm test` | 10 tests: 9 pass, 0 fail, 1 skipped (200 000 objects) |
| all-types fixture | 0 hash mismatches, 0 sample mismatches over > 1 000 fields, 0 FK violations, source SHA-256 unchanged |
| scale 20 000 objects (2 lists each, self links) | convert + verify 1.6 s, peak RSS 189 MB |
| scale 200 000 (`KEEL_SCALE_200K=1`) | convert + verify 16.3 s (load 7.4 s, verify 8.9 s), peak RSS 420 MB, 20 MB in, 19.7 MB out |

## Known limits

- **Order without SORT.** The SDK returns objects in insertion order; SQLite tables
  with a primary key have no insertion order, so unsorted results (and `LIMIT`
  without `SORT`) differ. Fix if needed: store the SDK object key in a column and
  order by it.
- `int` above 2^53: the JS SDK already returns a rounded number; the report counts them.
- `mixed`: the JS SDK returns int and double as the same JS number; stored as `{"t":"number"}`.
- Dates: millisecond precision (what the JS SDK exposes).
- Sets, dictionaries and mixed are JSON, not tables; the translator rejects them in queries.
- Backlinks on embedded classes and backlinks whose origin is inside an embedded object are not converted.
- Query translator: no `DISTINCT`, `BETWEEN`, `@sum/@avg/@min/@max`, `@links`, `[d]`,
  date literals (use `$n`), subqueries, comparisons on decimal128/data, `ALL`/`NONE`
  over more than two nested lists, two key paths through lists. These raise `Unsupported`.
- Strings with a NUL character are stored whole, but SQLite `length()`/`instr()` stop at the NUL.
- Files that need a format upgrade cannot be opened read-only; they fail with the SDK error (open a copy).
- Asymmetric classes are skipped.
