#!/usr/bin/env node
// afterdb-convert <in.realm> <out.sqlite> [--schema <schema.mjs>] [--report <dir>]  (key in AFTERDB_KEY)
import fs from 'node:fs';
import os from 'node:os';
import Realm from 'realm';
import { convert, removeCreatedFiles, sourceChange } from '../src/convert.mjs';

const USAGE = `Usage: afterdb-convert <input> <output.sqlite> [options]
  --key <128 hex>      encryption key of the input file (64 bytes); visible in ps,
                       prefer the AFTERDB_KEY environment variable
  --schema <file.mjs>  app schema module: only adds backlinks, the file's schema is used
  --report <dir>       write report.json and report.md to <dir>
  --sample <n>         objects in the random field-by-field sample (default 300, 0 = none)
  --batch <n>          objects per transaction (default 1000, at least 1)
  --force              replace the output file once the new one is verified
Exit code: 0 verified, 2 verification failed (output kept as <output>.failed), 1 error.
Exit 0 with "source unchanged: false" and a warning: another program changed, truncated
or deleted the input after it was copied; the output is a verified snapshot of the copy
(close the app and run again for the current data).
The SDK reads only a private copy of the input, made in the output folder
(afterdb.<hex>.copy/, deleted at the end in every case): that folder needs free space
for the input plus the output.
Ctrl-C, SIGTERM, SIGHUP (also during the copy): the files of the run are deleted, then
the process ends by that signal (the shell shows 128 + signal number, 130 for Ctrl-C).
An option value may not start with "--" or be "-h" (write ./--name or ./-h for such a file).`;

// Ctrl-C, kill, closed terminal: delete the temporary output (and the report
// files) of the run, then end by the same signal with its default action. A
// shell running this in a script sees a death by SIGINT and stops the script
// too (bash and sh go on after a child that exits normally, even with 130).
// Long steps yield to the event loop every 50 ms (src/gc.mjs), so this runs quickly.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    removeCreatedFiles();
    try { fs.writeSync(2, `interrupted (${sig}): no output written\n`); } catch { /* stderr closed */ }
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
    setTimeout(() => process.exit(128 + os.constants.signals[sig]), 1000); // not reached normally
  });
}

function intOpt(name, v, min) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === '' || !Number.isInteger(n) || n < min) throw new Error(`--${name} needs a whole number of at least ${min}, got "${v}"`);
  return n;
}

function parse(argv) {
  const pos = [];
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (['--key', '--schema', '--report', '--sample', '--batch'].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--') || v === '-h') throw new Error(`${a} needs a value${v === undefined ? '' : `, got the option ${v}`}`);
      o[a.slice(2)] = v;
      i++;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, o };
}

let code = 0;
try {
  const { pos, o } = parse(process.argv.slice(2));
  if (o.help || pos.length !== 2) {
    console.log(USAGE);
    code = o.help ? 0 : 1;
  } else {
    if (o.report === '') throw new Error('--report needs a folder name, got an empty string');
    if (o.key) console.error('warning: --key is visible to other users in the process list (ps); prefer AFTERDB_KEY.');
    const r = await convert(pos[0], pos[1], {
      key: o.key ?? process.env.AFTERDB_KEY, schema: o.schema, report: o.report, force: o.force,
      sample: intOpt('sample', o.sample, 0), batchSize: intOpt('batch', o.batch, 1),
    });
    const v = r.verification;
    const rows = v.tables.reduce((s, t) => s + t.rows, 0);
    // "source unchanged: false": another program changed, truncated or deleted
    // the source after the copy; the output is a snapshot of the copy. Still
    // exit 0 when it is verified (README, Exit code), with a warning below.
    const source = r.input.unchanged ? 'source unchanged: true' : `source unchanged: false (${sourceChange(r.input, r.ok)})`;
    console.log(`${r.ok ? 'OK' : 'FAILED'}: ${v.tables.length} tables, ${rows} rows, ${v.mismatchCount} hash mismatches, ` +
      `${v.sample.mismatchCount}/${v.sample.fields} sample field mismatches, ${v.foreignKeyCheck.violations} FK violations, ` +
      `${source}, ${r.timings.totalMs} ms`);
    for (const w of r.warnings) console.log('warning: ' + w);
    if (o.report) console.log(`report: ${o.report}/report.md`);
    code = r.ok ? 0 : 2;
  }
} catch (e) {
  console.error('error: ' + e.message);
  code = 1;
}
Realm.shutdown();
process.exit(code);
