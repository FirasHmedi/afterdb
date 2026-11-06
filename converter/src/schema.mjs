// The SQL model is always built from the schema stored in the file. The app
// schema (--schema) only adds backlinks (linkingObjects), which the file does
// not store, and is compared with the file to report drift.
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The SDK's own normalizer (string shorthands, Realm.Object classes). Not in the
// package "exports", so it is loaded by path; realm is pinned in package.json.
const { normalizeRealmSchema } = require(path.join(path.dirname(require.resolve('realm/package.json')), 'dist/schema/normalize.js'));

export function normalizeAppSchema(schema) {
  return normalizeRealmSchema(schema);
}

const stored = (p) => p.mapTo || p.name;
// Optionality is part of the type, as in the SDK (`int` and `int?` differ).
const typeOf = (p) => {
  const opt = p.optional ? '?' : '';
  if (p.type === 'object') return p.objectType + opt;
  return p.objectType ? `${p.type}<${p.objectType}${opt}>` : p.type + opt;
};
const kindOf = (c) => (c.embedded ? 'embedded' : c.asymmetric ? 'asymmetric' : 'top-level');
const indexOf = (p) => (p.indexed === 'full-text' ? 'full-text indexed' : p.indexed ? 'indexed' : 'not indexed');
// The schemas are plain objects: `properties.toString` must not find Object.prototype.
const has = (o, k) => Object.hasOwn(o, k);

/**
 * @param {Array} fileSchema realm.schema of the file opened without a schema
 * @param {Array} appSchema the app schema, any form accepted by the SDK
 * @returns {{schema: Array, warnings: string[], backlinks: number}} file schema plus the app's backlinks
 */
export function mergeAppSchema(fileSchema, appSchema) {
  const app = normalizeAppSchema(appSchema);
  const out = JSON.parse(JSON.stringify(fileSchema));
  const warnings = [];
  const fileBy = new Map(out.map((c) => [c.name, c]));
  const appBy = new Map(app.map((c) => [c.name, c]));
  const drift = (s) => warnings.push(`Schema drift: ${s}`);
  let backlinks = 0;

  for (const c of out) {
    if (!appBy.has(c.name)) drift(`class ${c.name} is in the file but not in the app schema; converted from the file.`);
  }
  for (const a of app) {
    const f = fileBy.get(a.name);
    if (!f) {
      drift(`class ${a.name} is in the app schema but not in the file; no table.`);
      continue;
    }
    if (kindOf(a) !== kindOf(f)) {
      drift(`class ${a.name} is ${kindOf(f)} in the file, ${kindOf(a)} in the app schema; the file is used.`);
    }
    if ((a.primaryKey ?? null) !== (f.primaryKey ?? null)) {
      drift(`${a.name}: primary key is ${f.primaryKey ?? 'none'} in the file, ${a.primaryKey ?? 'none'} in the app schema; the file is used.`);
    }
    const appProps = Object.values(a.properties).filter((p) => p.type !== 'linkingObjects');
    const appStored = new Map(appProps.map((p) => [stored(p), p]));
    for (const p of Object.values(f.properties)) {
      const ap = appStored.get(p.name);
      if (!ap) {
        drift(`property ${f.name}.${p.name} is in the file but not in the app schema; converted from the file.`);
        continue;
      }
      if (typeOf(ap) !== typeOf(p)) drift(`${f.name}.${p.name} is ${typeOf(p)} in the file, ${typeOf(ap)} in the app schema; the file is used.`);
      if (indexOf(ap) !== indexOf(p)) drift(`${f.name}.${p.name} is ${indexOf(p)} in the file, ${indexOf(ap)} in the app schema; the file is used.`);
    }
    for (const ap of appProps) {
      if (!has(f.properties, stored(ap))) drift(`property ${a.name}.${stored(ap)} is in the app schema but not in the file; no column.`);
    }
    for (const bl of Object.values(a.properties).filter((p) => p.type === 'linkingObjects')) {
      if (has(f.properties, bl.name)) {
        warnings.push(`${a.name}.${bl.name}: backlink has the name of a stored property; skipped.`);
        continue;
      }
      // `property` is the stored name of the origin (the SDK requires it with mapTo too).
      f.properties[bl.name] = { name: bl.name, type: 'linkingObjects', objectType: bl.objectType, property: bl.property, optional: false, indexed: false };
      backlinks++;
    }
  }
  return { schema: out, warnings, backlinks };
}
