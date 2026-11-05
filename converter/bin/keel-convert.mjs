#!/usr/bin/env node
// keel-convert <in.realm> <out.sqlite> [--key <hex>] [--schema <schema.mjs>] [--report <dir>]
import Realm from 'realm';
import { convert } from '../src/convert.mjs';

const USAGE = `Usage: keel-convert <input> <output.sqlite> [options]
  --key <128 hex>      encryption key of the input file (64 bytes)
  --schema <file.mjs>  app schema module (needed for backlinks)
  --report <dir>       write report.json and report.md to <dir>
  --sample <n>         objects in the random field-by-field sample (default 300)
  --batch <n>          objects per transaction (default 1000)
  --force              overwrite the output file
Exit code: 0 verified, 2 verification failed, 1 error.`;

function parse(argv) {
  const pos = [];
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (['--key', '--schema', '--report', '--sample', '--batch'].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
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
    const r = await convert(pos[0], pos[1], {
      key: o.key ?? process.env.KEEL_KEY, schema: o.schema, report: o.report, force: o.force,
      sample: o.sample ? Number(o.sample) : undefined, batchSize: o.batch ? Number(o.batch) : undefined,
    });
    const v = r.verification;
    const rows = v.tables.reduce((s, t) => s + t.rows, 0);
    console.log(`${r.ok ? 'OK' : 'FAILED'}: ${v.tables.length} tables, ${rows} rows, ${v.mismatchCount} hash mismatches, ` +
      `${v.sample.mismatchCount}/${v.sample.fields} sample field mismatches, ${v.foreignKeyCheck.violations} FK violations, ` +
      `source unchanged: ${r.input.unchanged}, ${r.timings.totalMs} ms`);
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
