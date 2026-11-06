// report.json + report.md
import fs from 'node:fs';
import path from 'node:path';

const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
const yes = (b) => (b ? 'yes' : '**NO**');

export function toMarkdown(r) {
  const v = r.verification;
  const L = [];
  L.push(`# Conversion report`, '');
  L.push(`Result: **${r.ok ? 'OK' : 'FAILED'}**  `);
  L.push(`Tool: ${r.tool}, ${r.createdAt}, ${r.platform}`, '');
  L.push('## Files', '');
  L.push('| | path | size | SHA-256 |', '|---|---|---|---|');
  L.push(`| input${r.input.encrypted ? ' (encrypted)' : ''} | ${path.basename(r.input.path)} | ${mb(r.input.bytes)} | ${r.input.sha256Before} |`);
  L.push(`| output | ${path.basename(r.output.path)} | ${mb(r.output.bytes)} | |`, '');
  L.push(`Source unchanged after conversion (SHA-256 before = after): ${yes(r.input.unchanged)}  `);
  L.push(`Schema from: ${r.schemaSource}. Classes: ${r.classes}, embedded classes: ${r.embeddedClasses}.`, '');
  L.push('## Counts', '', '| class | objects | rows | ok |', '|---|---:|---:|---|');
  for (const t of v.tables) L.push(`| ${t.class} | ${t.objects} | ${t.rows} | ${yes(t.ok)} |`);
  if (v.lists.length) {
    L.push('', '| list table | elements | rows | ok |', '|---|---:|---:|---|');
    for (const t of v.lists) L.push(`| ${t.table} | ${t.expected} | ${t.rows} | ${yes(t.ok)} |`);
  }
  if (v.views.length) {
    L.push('', '| backlink view | backlinks | rows | ok |', '|---|---:|---:|---|');
    for (const t of v.views) L.push(`| ${t.view} | ${t.expected} | ${t.rows} | ${yes(t.ok)} |`);
  }
  L.push('', '## Checks', '');
  L.push(`- Every class and property of the file is in the output: ${v.schemaCheck.ok ? 'yes' : '**NO**, missing: ' + v.schemaCheck.missing.join(', ')}`);
  L.push(`- Foreign key check: ${v.foreignKeyCheck.violations} violation(s)`);
  L.push(`- Integrity check: ${v.integrityCheck}`);
  L.push(`- Per-object SHA-256 mismatches: ${v.mismatchCount}`);
  L.push(`- Random sample: ${v.sample.objects} objects, ${v.sample.fields} fields compared, ${v.sample.mismatchCount} mismatch(es)`);
  L.push(`- NaN / -0 / ±Infinity values: ${v.lossy.realm} in source, ${v.lossy.sqlite} read back from SQLite`);
  L.push('', '| class | source digest | SQLite digest | equal |', '|---|---|---|---|');
  for (const d of v.digests) L.push(`| ${d.class} | ${d.source.slice(0, 16)}… | ${d.sqlite.slice(0, 16)}… | ${yes(d.equal)} |`);
  if (v.mismatches.length) {
    L.push('', '### Mismatches (first 100)', '');
    for (const m of v.mismatches) L.push(`- ${m.class} ${JSON.stringify(m.key)}: ${m.reason}${m.fields?.length ? ' (' + m.fields.join(', ') + ')' : ''}`);
  }
  if (v.sample.mismatches.length) {
    L.push('', '### Sample mismatches', '');
    for (const m of v.sample.mismatches) L.push(`- ${m.class} ${JSON.stringify(m.key)}.${m.field}: source ${m.source} / sqlite ${m.sqlite}`);
  }
  L.push('', '## Warnings', '');
  if (!r.warnings.length) L.push('None.');
  for (const w of r.warnings) L.push(`- ${w}`);
  L.push('', '## Timing', '', '| step | ms |', '|---|---:|');
  for (const [k, ms] of Object.entries(r.timings)) L.push(`| ${k.replace(/Ms$/, '')} | ${ms} |`);
  L.push('', `Peak RSS: ${r.peakRssMB} MB`, '');
  return L.join('\n');
}

export function writeReport(dir, report) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), toMarkdown(report));
}
