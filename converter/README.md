# @pomwik/afterdb-convert

`afterdb-convert` reads a local object database file (the `.realm` format used by
React Native apps) and writes an equivalent SQLite database. Then it checks the
result against the source and writes a report. The tool never writes, renames
or deletes the source, and the SDK never opens it: it reads a private copy.

How the source is read:

1. the run hashes the source (SHA-256);
2. it copies the source to `afterdb.<12 hex>.copy/source.realm`, a new private
   folder (`0700`, random name, created exclusively) in the folder of the
   output, which may be the folder of the source;
3. it hashes the copy and the source again. The three hashes must be equal,
   otherwise the run stops with exit 1 (`the file changed while it was copied`);
4. the SDK opens only the copy, read-only, and the conversion and the
   verification read the copy. An app can keep the source open and write to it
   meanwhile: realm-core can crash a process that has a file open read-only
   while another process writes to it, and the copy avoids that;
5. at the end, the copy is hashed again (it must not have changed), and so is
   the source (see Exit code below);
6. the copy folder is deleted at the end of the run in every case: success,
   failed verification, error, Ctrl-C, SIGTERM or SIGHUP (also during the copy
   itself). Only SIGKILL or a machine stop can leave it behind, together with
   `afterdb.<12 hex>.partial` (see Output files); no later run uses or deletes
   them, delete them by hand.

The copy needs free disk space in the folder of the output: the size of the
input, on top of the output. On APFS (macOS) it is a real copy (measured with
Node 22.19, which does not clone files there); where Node can clone a file
(btrfs, XFS on Linux) it is a clone and takes no space. A copy that fails (disk
full) ends the run with exit 1: `cannot copy the input into the output folder`.
Whatever the SDK creates next to the file it opens is inside the copy folder.

The tool deletes nothing next to the source: `<input>.lock`, `<input>.note` and
`<input>.management/` belong to the app, which may open the file while a
conversion runs (deleting them would let a second writer change the file while
the app writes to it, and a committed write could be lost).

Private package, not published yet. License: Apache-2.0. Node 22+, ESM, no build step.

```
npm install
AFTERDB_KEY=<128 hex> npx afterdb-convert app.realm app.sqlite [--schema schema.mjs] [--report out/]
```

| option | |
|---|---|
| `AFTERDB_KEY` (environment) | encryption key of the source, 64 bytes as 128 hex characters. Recommended way to pass the key |
| `--key` | same key on the command line. Other users can see it in `ps`, so the CLI prints a warning; use `AFTERDB_KEY` |
| `--schema` | the app's JS schema module (`export const schema = [...]` or a default export). Only used to add backlinks, which are not stored in the file (see Schema) |
| `--report <dir>` | writes `report.json` and `report.md` to this folder (created if needed) |
| `--sample <n>` | size of the field-by-field random sample: a whole number, default 300, 0 for no sample |
| `--batch <n>` | objects per transaction: a whole number, at least 1, default 1000 |
| `--force` | replace an existing output, once the new one is verified |

An option value may not start with `--` or be `-h`: `--report --force` is
refused (`--report needs a value, got the option --force`) instead of creating a
folder named `--force`. For such a name, write `./--force` (or `./-h`).

Exit code: 0 verified, 2 verification failed, 1 error (bad option or path,
unreadable source, source changed while it was copied, no space for the copy,
report that cannot be written...). After exit 1, no output file is written, the
files the run created are deleted, and an old `<out>` and an old report are
left as they were.

Source changed after the copy: the source is hashed again at the end of the
run. If another program wrote to it, truncated, replaced or deleted it after
the copy, the run still ends with exit 0 when the output is verified: the
output is a verified snapshot of the copy, not of the file as it is now. The
CLI line then says `source unchanged: false (<what happened>; the output is a
verified snapshot of the copy taken at <time>)`, and a warning follows. The
report says the same (**NO** in report.md) and has, under `input`:
`unchanged: false`, `snapshot: true`, `copiedAt`, `sha256After`, `bytesAfter`
and `atEnd`:

| `atEnd` | when | `<what happened>` |
|---|---|---|
| `unchanged` | same SHA-256 as the copy | (no warning) |
| `changed` | other bytes, or another file at that path (a smaller one too: the app's `compact()` writes a new file) | `another program wrote to it or replaced it after it was copied` |
| `truncated` | the same file (same inode), cut short: what is left is the start of the copy | `it was truncated after it was copied (<n> bytes now, <m> copied)` |
| `deleted` | nothing at that path (deleted or moved) | `it was deleted or moved after it was copied` |
| `unreadable` | there, but it cannot be read (permissions) | `it could not be read at the end of the run` |

`sha256After` and `bytesAfter` are null for `deleted` and `unreadable`. Exit 2
stays for a failed verification only. For the current data, close the app and
run again; a script can test `input.unchanged` in report.json.

Ctrl-C, SIGTERM and SIGHUP: the run deletes the files it created, prints
`interrupted (SIGINT): no output written`, then ends by that same signal (default
action). The shell shows 128 + signal number (130 for Ctrl-C, 143 for SIGTERM,
129 for SIGHUP), and a bash or sh script that runs `afterdb-convert` stops too (a
normal exit with 130 would let the script go on). The interrupt is handled within
about 50 ms, whatever `--batch` is: long loops yield to the event loop every
50 ms (src/gc.mjs), inside a transaction too. Only one SQLite statement (an index
build, `PRAGMA integrity_check`) can delay it; about 0.2 s at most for 200 000
objects. The copy of the source runs off the main thread (`fs.promises.copyFile`,
with `COPYFILE_FICLONE`), so an interrupt during the copy is handled at once
too: the copy folder is deleted while the copy is still being written (the
partly written file is unlinked; its space is freed when the process ends).
Measured: 512 MiB input, SIGINT, SIGTERM and SIGHUP during the copy, process
ended 5 to 9 ms after the signal, nothing left in the output folder (a blocking
`copyFileSync` waited for the end of the copy: 0.8 s).

### Output files

The database is written to a new temporary file in the folder of the output,
`afterdb.<12 hex>.partial`, with a random name and created exclusively, so no
existing file is ever reused or deleted (a name whose SQLite side files exist is
skipped too). Its name does not depend on `<out>`, so any output name works as
long as SQLite can create `<out>-journal` next to it later: at most 247 bytes
on disks that allow 255 bytes per name; a longer name is refused before any work
(`output name too long for this disk`). If verification passes, the file gets
the name `<out>` (a new name created with `link()`; with `--force`, a rename
that replaces the old file only at that moment, before that the old file is
untouched). If verification fails, it is renamed to `<out>.failed` (replacing an
older `.failed`) and `<out>` is not written, so a failed file cannot be shipped
by mistake.

Permissions: the database and the report files get the read/write bits of the
input, at most `0644` and always owner read/write, minus the umask (`0600` input, `0600` output: a plaintext
copy of an encrypted private file stays private; `0644` input: `0644` output
under umask `022` or `002`, `0640` under `027`, `0600` under `077`). A file replaced with `--force` (or an old `<out>.failed`, an
old report) keeps narrower permissions: an output set to `0600` stays `0600`.

The report is written first to `.report.json.<12 hex>.tmp` and
`.report.md.<12 hex>.tmp` in the report folder (created if needed). Then, in
this order:

1. every final check (below), including "`<out>` exists without `--force`";
2. without `--force`, when verification passed: the database takes the name
   `<out>` with `link()`, which fails if anything (another run, another program,
   a dangling link) appeared at `<out>` meanwhile, so nothing is overwritten
   between the check and the rename. Only the run that gets `<out>` goes on;
   a run that fails here has not touched the report;
3. an old `report.json` / `report.md` is moved aside to
   `.report.json.<12 hex>.old` (not deleted) and the new file takes its name
   (the rename does not follow a link at `report.json`: it moves the link itself);
4. with `--force`, or for `<out>.failed`: the database is renamed onto `<out>`
   (or `<out>.failed`), replacing the old file. This is the commit;
5. the old reports moved aside are deleted.

If step 3 or 4 fails (for example `<out>` is locked), the new report files are
deleted, the old ones are moved back, and a `<out>` created at step 2 is deleted
again (only if it still holds the file of this run), so the old report and the
old `<out>` stay as they were. A run that fails never deletes or replaces the
report of a run that succeeded. Two runs with `--force` on the same output at the
same time: both succeed, the last rename wins, and the report can come from the
other run (measured: 1 of 12 rounds of 4 concurrent runs); without `--force` the
report always describes `<out>`.

On an error or an interrupt, the run deletes what it created, and only that:
the private copy folder `afterdb.<12 hex>.copy/` (deleted at the end of every
run, see the top of this file), the temporary file and its SQLite side files
(`afterdb.<12 hex>.partial-journal`,
which SQLite writes during each transaction; the name was only taken when none of
them existed), the new report files and the report folders it created (if
empty). A file is deleted only if its path still holds the file the run created
(same inode). Nothing next to the input is deleted (see the top of this file). If
the process is killed with SIGKILL or the machine stops, `afterdb.<12 hex>.copy/`
and `afterdb.<12 hex>.partial` (and its `-journal`, and an old report as
`.report.json.<12 hex>.old` if it happened during step 3) are left behind; no
later run uses or deletes them, delete them by hand.

Before any work, with or without `--force`, the run stops with exit 1 if:

- the output path is empty, ends with `/`, `/.` or `/..`, is a folder (or a
  link to one), or its folder does not exist as the system resolves it
  (`sub/../o.sqlite` needs `sub`; the temporary file and the copy go there too); the output name is too long for SQLite's
  `<out>-journal` (see above), or the report folder name is too long;
- `<out>` exists (a file, a link, even a dangling one) and `--force` is not given;
- one of the files the run may create or replace is the input (same path, the
  same name in another case on a case-insensitive disk, or a link to it) or a
  file the SDK keeps next to the input (`<input>.lock`, `.note`,
  `.management`...), or is inside `.management`. These are `<out>`,
  `<out>.failed`, their SQLite side files `-journal`, `-wal` and `-shm` (SQLite
  applies or deletes them when it opens the database next to them), the report
  folder and `report.json` / `report.md`. The SDK files need not exist (the app
  creates them when it opens the input, and would then overwrite the output):
  they are compared by name, ignoring case and Unicode normalization on every
  disk (`app.realm.Lock`, `--report APP.realm.management` are refused, also on a
  case-sensitive disk), and by inode when they exist (links);
- `<out>-journal`, `<out>-wal` or `<out>-shm` exists: it belongs to the old
  database or to a program that has it open, and SQLite would apply it to the
  new file. The tool does not delete it;
- `--report` is empty, is a file, cannot be written, or overlaps the output: it
  is `<out>`, `<out>.failed` or one of their side files, or is inside one of
  them, or `report.json` / `report.md` is one of them (same path or a link to
  it). `report.json` or `report.md` is a folder, or a read-only file.

`<out>.failed` is only needed when verification fails, so a folder (or a
`-journal`, `-wal`, `-shm` file) at `<out>.failed` does not stop a run that
passes. When verification fails and `<out>.failed` cannot be used, the run ends
with exit 1 and deletes the failed file. The same checks run again at the end
(step 1 above), after the report folder and temporary files exist and before
any old file is touched, to catch files that appeared during the run (by inode:
the input and the SDK files next to it) and two new names that differ only in
case on a case-insensitive disk. A case variant of
`report.json` itself as `<out>` (`--report rep` with `<out>` = `rep/Report.json`)
can only be seen once both names exist: it is checked before and after step 3,
and the run then ends with exit 1, leaving the old report as it was.

API: `convert(input, output, opts)`, `verifyFile(input, sqlite, opts)` (src/convert.mjs),
`translate(query, { model, className, args, quirks })` (src/rql.mjs). The mapping
model is stored in the output, in table `_afterdb_meta` (key `model`). In the API,
`opts.report` is a folder name, or `undefined`, `null` or `false` for no report;
any other value (`''`, `0`, `true`) is an error (`report must be a folder name`).

## Schema

The source is always opened without a schema, so the SDK shows exactly the
classes and properties stored in the file, and the SQL model is built from that.
Classes or properties that the app no longer declares are still in the file
(the SDK does not delete them) and are converted.

`--schema` only adds backlinks (`linkingObjects`), which exist in the app code
and not in the file. The app schema is also compared with the file; each
difference is a `Schema drift:` warning in the report. Compared: classes and
properties present on each side (only in the file: converted; only in the app
schema: no table or column), embedded or top-level class, primary key, property
type with optionality (`int` and `int?` differ, so do `int[]` and `int?[]`) and
index. For the last four, the file wins. Verification reads the file the same
way and also checks that every class and property of the file is in the output.

## Name conflicts

SQLite names ignore ASCII case, the object database does not. Generated names
can also collide (list table `A__b` for class `A`, list `b`, next to a class
`A__b`), and `_afterdb_meta` and `sqlite_*` are reserved. Such names get a suffix:

- class tables are named first, in code-unit order: `Item` keeps its name,
  `item` becomes `item_2`; a class `_afterdb_meta` becomes `_afterdb_meta_2`;
  `sqlite_x` becomes `_sqlite_x`;
- then columns, in property order (the primary key column never changes):
  `name` stays, `Name` becomes `Name_2`; a property `d__x` next to a double `d`
  becomes `d__x_2`;
- then list tables, then indexes, then backlink views: `A__b_2`. Backlink
  views come only from `--schema`, so they are named last: with or without
  `--schema`, tables and indexes get the same names.

Each rename (indexes included) is a warning in the report and is recorded in
`_afterdb_meta` (key `renames`: `[{kind, class, prop, from, to}]`) and in the
model, which the query translator uses. The names depend only on the file's
schema (and, for views, on `--schema`), so a second conversion with the same
options gives the same names. One case still fails, with a clear message: a
class without primary key that has a property (or a backlink) named exactly
`_rid`.

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
  the file stores no backlinks, so on the source side they are computed from
  the forward links (once per link, as the SDK counts them), not with
  `linkingObjects()`, which fails when the class has a stored property named
  `objectSchema` or `constructor`; a test checks that both give the same keys;
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

Both readers and the writer read SDK objects without calling methods on them
(src/sdk.mjs): a stored property can be named like an SDK member
(`objectSchema`, `constructor`, `_objectKey`, `linkingObjects`, `keys`...), and a
dictionary key like a dictionary method (`values`, `toString`, `set`...) or
`__proto__`. Objects are mapped to their class by prototype, and dictionaries
are read with `Dictionary.prototype.entries`.

Memory: the SDK frees native memory through finalizers that only run on the
event loop. Conversion and verification yield and force a GC every 10 000
objects, inside a transaction too (src/gc.mjs); without it RSS grew to 2.9 GB
for 200 000 objects. They also yield every 50 ms, so that signals are handled
(see the exit codes above).

## Query translation (src/rql.mjs)

Translates a subset of the query language to SQL over the generated schema:
comparisons on int/double/float/string/bool/date/objectId/uuid, `AND/OR/NOT`,
`BEGINSWITH`, `ENDSWITH`, `CONTAINS`, `LIKE` (with `[c]`), `IN {…}` and
`== ANY {…}` (also `== SOME {…}` and `== ANY $n` with an array), key paths
through links, lists, backlinks and embedded objects, two key paths of
compatible types, `@count`/`@size`, `ANY/SOME/ALL/NONE`, `SORT`, `LIMIT`,
`TRUEPREDICATE`, `nan`/`inf` constants, `$n` arguments. Each comparison compiles
to a two-valued SQL expression (never NULL), so `NOT` behaves like the SDK. A
class name that is not in the model (`toString` included) raises `RqlError`.

Errors: when it gives no SQL, `translate()` throws an `RqlError`. `Unsupported`
is a subclass of `RqlError`, so test for it first.

- `Unsupported`: the translator refuses the query; run it with the SDK. The SDK
  answers many of these (typed literals, `@links`, subscripts...) and refuses
  some others.
- any other `RqlError`: the SDK refuses the query too, in every case measured
  (realm 20.2.0; `test/diff.test.mjs` and `test/regressions.test.mjs` fail when
  the translator raises it for a query the SDK answers). This is measured, not
  proven for every query: a caller that must not lose a valid query can run it
  with the SDK on any `RqlError`.

Property names: queries use the names stored in the file. The public names
that an app gives with `mapTo` are translated too when the model was built with
`--schema` (the SDK accepts both names). Without `--schema` the model knows
neither public names nor backlinks, so a name that is not in the file raises
`Unsupported`; with `--schema`, an unknown name raises `RqlError`.

Arguments: numbers (bigint included), strings, booleans, `Date`, `ObjectId`,
`UUID`, `Decimal128` and SDK objects (for links to their class; an object of
another class is refused, as in the SDK). A `Decimal128` is compared as the SDK
does: as a double with a double or float property, exactly with an int (refused
when the double would not give the same answer, above 2^53). An array argument
compares with each element and is true when one matches (`age == $0` with
`[1, 2]`), as in the SDK; `IN $n` needs an array (a number, `null` or a string is
an `RqlError`, as in the SDK). A value of a type the SDK refuses for the property
is an `RqlError` (`flag == 1`, `born == 1000`, `oid == "507f…"` on an objectId,
a link compared with a number, `friends == null`); a string compared with a
number property is `Unsupported` (the SDK converts it to a number). Inside an
array argument or a `{list}`, a value of the wrong type is `Unsupported` (the SDK
skips it or converts it: `name == $0` with `["alice", 5]` is answered), except
on a link.

With `SORT`, ties are ordered by primary key (the SDK uses insertion order).
Without `SORT`, rows come in primary key order (the SDK uses insertion order).
Several `SORT` clauses: the last one written is the primary order and the earlier
ones order its ties, as in the SDK (`SORT(a ASC) SORT(b ASC)` sorts by `b`, then
`a`). Several `LIMIT`s keep the smallest. A `SORT` after a `LIMIT` sorts the
first objects in insertion order, which the SQLite file does not keep:
`Unsupported`.

### SDK behaviours reproduced

All measured on realm 20.2.0 with the differential test; the `nan`/`inf` rows
with the test `nan, inf and infinity are constants` in test/regressions.test.mjs
(about 2 200 queries over 15 property kinds, both sides); the rows on names,
strings, `@count`, `ALL`/`NONE`, two key paths and arguments with the tests of the
third pass in the same file (each query on the SDK and through the translator).
Rows marked *quirk* are reproduced only when `quirks: true` (the default);
`quirks: false` gives the plain meaning.

| behaviour | what the SDK does |
|---|---|
| property names | a name starts with a letter, `_`, `$` or any non-ASCII character and goes on with those, digits and `-` (`prénom`, `âge`, `prix$`, `x-1`, `nané`); a no-break space is part of a name; whitespace is space, tab, CR, LF only |
| keywords | `NOT`, `ANY`, `SOME`, `ALL`, `NONE`, `IN`, `TRUE`, `FALSE` only in upper or lower case (`Not`, `In`, `tRUE` are property names); the others in any case (`aNd`, `Null`, `Sort`, `Desc`). `IN`, `BEGINSWITH`, `ENDSWITH`, `CONTAINS`, `LIKE`, `BETWEEN`, `SORT`, `LIMIT`, `DISTINCT`, `ASC(ENDING)`, `DESC(ENDING)` are also property names where a name is expected (`sort == 1`, `l.in`); `and`, `or`, `not`, `any`, `null`, `truepredicate`... cannot be queried as names (the SDK refuses them too) |
| string literals | escapes are kept as typed: `"a\nb"` is the four characters `a`, `\`, `n`, `b`, and `"C:\\Users"` has two backslashes. Only `\"` `\'` `\/` `\0` `\\` `\b` `\f` `\n` `\r` `\t` and `\uXXXX` are accepted; another escape (`\x41`, `\v`, `\*`, `\u{41}`) is an error. Pass special characters as `$n` arguments |
| modifiers, operators | only `[c]` in lower case; `[C]`, `[d]`, `[cd]` are syntax errors, and so is `[c]` after `<`, `<=`, `>`, `>=` (`=<`, `=>`). `=<` and `=>` are `<=` and `>=` |
| integer literals | read like C's `strtoll` with base 0: a leading `0` is octal and stops at the first `8` or `9` (`010` is 8, `08` is 0, `019` is 1, `-010` is -8), `0x10` is 16 (no sign before `0x`), values beyond 64 bits saturate. A fraction or an exponent makes a decimal number (`010.5`, `010e0` is 10). In `LIMIT`, digits only (`LIMIT(010)` is 8, `LIMIT(0x3)` and `LIMIT(+3)` are errors). A trailing comma in `{1, 2,}` is an error |
| `[c]` on a property that is not a string | ignored by `IN`, except on a link (`l IN[c] {…}`, `l IN[c] $0` are errors; `l ==[c] ANY {…}` follows the `==` rule); with `==` and `!=`, ignored on a property of the base object (or a list of links there, with `ANY` or no quantifier; with `ALL` or `NONE` an error: `ALL friends ==[c] $0`, `NONE fans ==[c] ANY {$0}`) compared with a value, an error through a link, a list of values, an embedded object or on `@count`/`@size`, and an error with `null` (except on a link, an embedded object or data of the base object) |
| two key paths | the same type, or two numbers (`s == i`, `dt == i`, `oid == s`, `i == l` are errors); links only with `==` and `!=`; a string operator or `[c]` needs a string on the right (`i CONTAINS j`, `l ==[c] l` are errors) |
| `x == {a, b}` without `ANY` | on a property, ANY (`x == a OR x == b`, false for `{}`, with `!=` too); on a list, the whole list. Not translated (`Unsupported`), with any operator but `IN`; `== ANY {…}` and `IN {…}` are |
| `list == ANY {a, b}` | the element test, like `ANY list IN {a, b}` (not the whole-list `list IN {a, b}`) |
| bool ordering | `false < true`; null matches no `<`, `<=`, `>`, `>=` with a value (`b <= null` is `b == null`) |
| a null embedded object | through links it reads as null (`home.n == null` is true when `home` is null; SORT puts it after the values, also for `home.sub.n`); inside a list it drops the element, as a null link does (`ALL friends.home.n > 2` ignores friends without `home`); `friends.home == null` is an error |
| `true` / `false` | literals only as `true`, `TRUE`, `false`, `FALSE`; `True` or `tRUE` is a property name |
| `[c]` | folds ASCII and Latin-1 `À`–`Þ` only (`É`=`é`, `Ç`=`ç`; `Œ`≠`œ`, `Ÿ`≠`ÿ`, `ß`≠`SS`, `İ`≠`i`). SQLite `lower()` folds ASCII only and JS `toLowerCase()` folds too much; we emit `lower()` over 30 `replace()` calls |
| string ordering, `LIKE` | byte order (= SQLite `BINARY`); `LIKE` uses `*` and `?` (one code point), `[` is literal (we use `GLOB` with `[` escaped) |
| `@count`, `@size` | the same operator, lower case only: the count of a collection, or the length of a string in UTF-8 bytes |
| `@count` after a list | `friends.tags.@count == 2`, `friends.name.@size == 2`: true when one friend's own count or size matches (ANY). With a quantifier (`ANY tags.@count == 1`, `ALL friends.name.@size == 2`) the SDK answers; not translated (`Unsupported`) |
| null through links | `boss.name == null` is true when `boss` is null (LEFT JOIN) |
| null inside lists | a null link inside a list path drops the element: `ANY friends.city.name == null` is false for a friend without city (inner JOIN). A null to-one link at the end of the path drops it too: `friends.boss != $0`, `ALL friends.boss == $0`, `ALL friends.boss == boss` ignore the friends without a boss (`friends.boss == null` is an error) |
| a list of links and `null` in `IN` | `ANY friends IN {null}`, `ANY friends.boss == ANY {null}`, `IN $0` with `[null]`: an error (a single null); with more values (`IN {null, $0}`, `IN {null, null}`) the null matches nothing |
| `ALL`/`NONE` over two lists of objects | `ALL friends.friends.age > 3` (links or backlinks, both lists): every object reached through both lists matches (none for `NONE`) |
| `ALL`/`NONE` over a list of objects, then a list of values | `ALL friends.tags == x` = no friends, or at least one friend whose tags all equal x (the quantifier applies to the last list, the first one is ANY) |
| `@count` through a null link | a list of objects, of backlinks or of embedded objects: every comparison is false, `!=` included; a list of values counts 0 (`boss.tags.@count == 0` is true when `boss` is null); `@size` of a string is null (`boss.name.@size != 0` is true, `== null` is true) |
| two key paths | `name <= nick` and `>=` are true when both are null (also through null links); `name CONTAINS nick` is true when `nick` is null and `name` is not |
| SORT through a null link / null embedded | those objects sort after all values (before with DESC); null values sort first |
| SORT on doubles | null < NaN < -Infinity < … |
| `nan`, `inf`, `infinity` | number constants in any case (`NaN`, `INF`, `Infinity`), with an optional sign (`-inf`, `+nan`); never property names, even after a dot (`l.inf` is a syntax error), so a property named `NaN` or `inf` cannot be queried |
| NaN on a base property | IEEE: every comparison false except `!=` |
| NaN in a list or through a link | NaN is below every number and `NaN == NaN`; null (or a null link) is not above NaN |
| NaN with an int (constant or `$n`), `@count`, `@size` | never equal, never below; above every value that is not null (`age > nan` is `age != null`) |
| Infinity with anything but double/float; NaN with a string, bool, date or link | an error (`RqlError` in the translator) |
| float property | the compared value is rounded to float first (`score >= 1e-300` is `score >= 0`) |
| comparisons with `null` | `<= null`/`>= null` are `== null`; `< null`/`> null` are false; `LIKE null` is `== null`; `CONTAINS null` means "not null"; `BEGINSWITH`/`ENDSWITH null` are false |
| *quirk* string property of the base class | null is below every string: `name < "b"` includes nulls, `name >= null` is always true, `name > null` is "not null", `CONTAINS/BEGINSWITH/ENDSWITH null` are always true. With the value on the left (`"b" > name`, `null < name`) the SDK has no such rule: compared as a string through a link (with `quirks: false` too) |
| *quirk* integer literal vs double property | NaN counts as below every number (`height < 0` includes NaN, `height < 0.0` does not) |
| *quirk* value on the left of a base double/float property | compared as through a link: `1.5 > height` includes NaN, `height < 1.5` does not; `nan == height` matches NaN, `height == nan` matches nothing |
| *quirk* `list IN {a, b}` without ANY | true when the whole list equals `[a, b]`, in order (`ANY list IN {…}` is the element test). Through a to-one link or an embedded object after the list (`friends.city.name IN {…}`, `friends.boss IN {…}`) the SDK gives other rows: `Unsupported` |
| *quirk* `IN[c]` on a base property | `[c]` is ignored (honoured through links, lists and embedded objects) |
| *quirk* `==[c]` with an array argument on a base string property | `[c]` is ignored: `name ==[c] $0` with `["alice"]` does not match `Alice`. `!=[c]`, the string operators, key paths through a link or an embedded object, `$0 ==[c] name` and a plain string argument keep it |
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

- **252 handwritten queries: 2 mismatches**, both known and listed above:
  `age > 10 LIMIT(5)` (LIMIT without SORT picks different objects) and
  `_id IN {…} SORT(_id ASC) LIMIT(2)` (SDK returns `undefined` entries).
  They include `[c]` with an array argument, backlinks compared with an
  object (`ALL fans == $0`, `ANY friends.fans == $0`, `$0 == fans`), and a list
  of objects then a to-one link compared with an object or a link
  (`friends.boss != $0`, `ALL fans.city == $0`, `ANY friends.boss == boss`).
- **Error classes**: 26 queries the SDK answers must raise `Unsupported` (typed
  literals, `f` suffix, subscripts, `@links`, `@count` with a quantifier or on a
  to-one link, arrays inside `{…}`, mixed arrays, base backlinks compared with
  an object, `list IN {…}` through a link after the list), and 24 queries the
  SDK refuses must raise an `RqlError` that is not `Unsupported` (among them
  `[c]` on a list of links with `ALL`/`NONE`, a single null in `IN` on a list
  of links).
- **fuzz 200 (seed 42, run by `npm test`): 12 mismatches**, all "LIMIT without
  SORT": the same query without LIMIT returns the same set on both sides.
  0 unexplained. 41 matching queries returned 0 rows, 18 returned all 300.
- Extra runs, 1000 queries each (`AFTERDB_FUZZ_N=1000 AFTERDB_FUZZ_SEED=n`): seeds 1–5
  give 35, 51, 46, 55, 63 mismatches: 248 "LIMIT without SORT", 2 "undefined
  entries", 0 unexplained.
- With SORT, the exact order (ties included) matched in 20 of 62 sorted queries
  (seed 42); the others differ only inside tie groups.

The test fails on any unexplained mismatch, and on an `RqlError` that is not
`Unsupported` for a query the SDK answers.

## Tests

`npm test` (about 26 s): conversion of every type and edge value (NaN, -0,
±Infinity, empty strings, É/Ç/ß/emoji, NFD, NUL character, 100 000-character
string, dates before 1970, max decimal128), with and without app schema,
encrypted source, tamper detection, CLI, differential queries, scale, schema
drift (missing class or property, optionality, embedded or not, index),
backlinks from `--schema`, `--force` and `.failed` handling, name conflicts.
test/regressions.test.mjs replays the inputs of the adversarial reviews: output
that is the input (same path, case variant, links), input named `<out>.partial`,
`<out>.partial-journal`, `<out>.failed`, `<out>-journal`, `-wal`, `-shm` or a
file the SDK keeps next to the input, a stale `<out>-journal`, `--report`
errors and overlaps with the output (report folder at `<out>`, `<out>` at
`report.json`, `report.json` linked to `<out>`, read-only old report), empty
output path, dangling link at `<out>`, `<out>.failed` folder, Ctrl-C during a
run, bad `--batch`/`--sample`, output folder, names that must not change with
`--schema`, index renames, backlinks named `toString`/`valueOf`, `"` in names,
stored properties named `_objectKey`, `linkingObjects`, `objectSchema`,
`constructor` (links, mixed links, backlinks, query arguments), dictionary keys
named `values`/`toString`/`__proto__`, backlinks computed from forward links vs
`linkingObjects()`, `nan`/`inf` constants against the SDK, class names such as
`toString` in `translate()`, and properties named `True`/`False` in queries.
The third pass adds: an error after the report rename (output created during
the run, locked old output with `--force`, a second run that finishes first, a
case variant of `report.json` as `<out>`) leaves the old report as it was;
option values that are options (`--report --force`); `report: false` in the
API; cleanup after a source that fails to open (garbage, wrong or missing key);
interrupt latency inside a 5 000-object batch (SIGINT, SIGTERM); Ctrl-C to the
process group of a bash and an sh loop; and, each query on the SDK and through
the translator: names and keywords as in the SDK lexer, escapes kept as typed,
several `SORT`s, `@count`/`@size` after a list and through null links, `ALL`/`NONE`
over two lists, two key paths with nulls, the value on the left of a string,
`quirks: false` with null, `Decimal128`/array/wrong-type arguments, NUL
characters. The fourth pass adds: an app that opens the source read-write during
a run (its `.lock`, `.note`, `.management` stay, and a second writer still waits
for its write transaction); outputs and report folders named like the SDK files
of the input in another case, or linked to them; output names of 227 to 300
bytes (up to 247 converts, longer is refused); file permissions from the input,
with `--force` and under several umasks; `-h` as an option value; and, each
query on the SDK and through the translator: `{list}` after other operators than
`IN`, `== ANY`/`== SOME` on lists, trailing commas, octal and hex literals (in
`LIMIT` too), two key paths of different types, `[c]` on every kind of property
and after `<`, bool/objectId/uuid orderings, data arguments, and null embedded
objects inside lists and in `SORT`.

Figures (darwin arm64, Node 22.19.0):

| test | result |
|---|---|
| `npm test` | 65 tests: 64 pass, 0 fail, 1 skipped (200 000 objects), 26 s |
| all-types fixture | 0 hash mismatches, 0 sample mismatches over > 1 000 fields, 0 FK violations, source SHA-256 unchanged |
| scale 20 000 objects (2 lists each, self links) | convert + verify about 2.2 s (2185 to 2216 ms over 4 runs, 2026-11-08), peak RSS 158 to 161 MB |
| scale 200 000 (`AFTERDB_SCALE_200K=1`) | convert + verify 15.9 s (load 6.8 s, verify 8.9 s), peak RSS 388 MB, 20 MB in, 19.7 MB out |
| interrupt (200 000 objects, `--batch 200000`) | SIGINT, SIGTERM, SIGHUP handled in 6 to 47 ms; longest event-loop block 0.2 s (one SQLite statement) |

## Known limits

- **Order without SORT.** The SDK returns objects in insertion order; SQLite tables
  with a primary key have no insertion order, so unsorted results (and `LIMIT`
  without `SORT`) differ. Fix if needed: store the SDK object key in a column and
  order by it.
- `int` above 2^53: the JS SDK already returns a rounded number; the report counts them.
  Integer literals in queries are rounded the same way, so comparisons with
  values above 2^53 (`i == 9007199254740993`, `d > 0x7fffffffffffffff`) can
  differ from the SDK, which compares the exact 64-bit values.
- `mixed`: the JS SDK returns int and double as the same JS number; stored as `{"t":"number"}`.
- Dates: millisecond precision (what the JS SDK exposes).
- Sets, dictionaries and mixed are JSON, not tables; the translator rejects them in queries.
- Backlinks on embedded classes and backlinks whose origin is inside an embedded object are not converted.
- Query translator: no `DISTINCT`, `BETWEEN`, `@sum/@avg/@min/@max`, `@links`
  (first in a key path or after a dot), typed literals (`T…:…` and
  `YYYY-MM-DD@…` dates, `oid(…)`, `uuid(…)`, `B64"…"`, `O<n>`) and float
  literals with an `f` suffix (`1.5f`): use `$n`, subscripts (`[FIRST]`,
  `[LAST]`, `[SIZE]`, `[0]`, `['key']`), a quantifier before a key path on the
  right (`i == ANY il`), `@count`/`@size` with `ANY`/`ALL`/`NONE` or on a to-one
  link or embedded object (`boss.@count`), an array argument inside `{…}`
  (`age IN {$0}`), a value of the wrong type inside an array argument or a
  `{list}`, `[c]` with an array argument on a property that is not a string,
  a list of backlinks of the base object compared with an object with `ANY` or
  no quantifier (`ANY fans == $0`, `fans != $0`, `fans == ANY {$0}`: measured,
  the SDK does not give the element test, `ANY fans == $0` matched nothing; write
  `$0 == fans` or `ANY fans IN {$0}`, which the SDK answers with the element
  test; `ALL`/`NONE`, backlinks further down a key path and `fans == boss` are
  translated), `list IN {…}` without `ANY` through a to-one link or an
  embedded object after the list (`friends.boss IN {$0}`), public `mapTo`
  names or backlinks when the model was built without `--schema`,
  subqueries, comparisons on decimal128/data (values, arguments, `IN`, string
  operators, two key paths), a `{list}` after any operator but `IN` or
  `== ANY`/`== SOME` (or on the left), `!= ANY {…}`, `> ANY {…}`, `== ALL {…}`,
  `== NONE {…}`, `IN ANY {…}`, two key paths that are links to two different
  classes (the SDK compares internal object keys) or a string operator with a
  property that is not a string on the left (`u CONTAINS s`), `[c]` with the
  value on the left of a property that is not a string, comparing an embedded
  object reached through a list, `ALL`/`NONE` over more than two
  nested lists or over a list of embedded objects inside a list, two key paths
  through lists, `@count` of a list inside an embedded object, `nan` in `IN {…}`
  on an int property (the SDK matched `-1` with `i IN {nan}`), a `SORT` after a
  `LIMIT`, `IN` with several values on `@count`/`@size` through a link, a list or
  an embedded object (measured: the SDK matches nothing, or objects without the
  link, while `== ANY {…}` works and is translated), a string compared with a
  number property, an array argument on a key path through a list, a
  `Decimal128` NaN argument, a `Decimal128` in `IN`, a `Decimal128` integer above
  2^53 compared with an int. These raise `Unsupported`: run them with the SDK.
- Query translator: an SDK object whose class has a stored property named
  `constructor` cannot be a query argument (`RqlError`); the SDK fails on it too.
- Strings with a NUL character are stored whole. `==`, ordering, `BEGINSWITH`,
  `ENDSWITH`, `CONTAINS` and `@size` compare the whole UTF-8 bytes and match the
  SDK. `LIKE` uses SQLite `GLOB`, which stops at the first NUL: with a NUL in the
  value, `LIKE` can return wrong rows (`"a\0b" LIKE "a?b"` is false in SQL and
  true in the SDK, `"b\0a" LIKE "*b"` is true in SQL and false in the SDK).
  A NUL in the `LIKE` pattern is refused (`Unsupported`).
- Files that need a format upgrade cannot be opened read-only, and the tool opens its private copy read-only: they fail with the SDK error. Upgrade a copy of the file first (open it once read-write with the SDK or the app), then convert that copy.
- Asymmetric classes are skipped.
- A class without primary key cannot have a property named `_rid` (fails with a message).
