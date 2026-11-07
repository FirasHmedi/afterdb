import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Realm from 'realm';
import { convert } from '../src/convert.mjs';
import { makeScale, tmpPath, scaleSchema } from './fixtures.mjs';

after(() => Realm.shutdown());

async function run(n) {
  const src = tmpPath(`scale${n}.realm`);
  let t = performance.now();
  await makeScale(src, n);
  const genMs = Math.round(performance.now() - t);
  t = performance.now();
  const r = await convert(src, tmpPath(`scale${n}.sqlite`), { schema: scaleSchema });
  const ms = Math.round(performance.now() - t);
  const maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(`scale ${n}: generate ${genMs} ms, convert+verify ${ms} ms (load ${r.timings.loadMs} ms, verify ${r.timings.verifyMs} ms), ` +
    `peak RSS ${maxRssMB} MB (sampled during conversion ${r.peakRssMB} MB), input ${(r.input.bytes / 1048576).toFixed(1)} MB, output ${(r.output.bytes / 1048576).toFixed(1)} MB`);
  assert.equal(r.ok, true);
  assert.equal(r.verification.mismatchCount, 0);
  assert.equal(r.verification.tables[0].rows, n);
  return ms;
}

test('scale: 20 000 objects under 60 s', { timeout: 60_000 }, async () => {
  const ms = await run(20_000);
  assert.ok(ms < 60_000);
});

test('scale: 200 000 objects (set AFTERDB_SCALE_200K=1)', { skip: !process.env.AFTERDB_SCALE_200K, timeout: 600_000 }, async () => {
  await run(200_000);
});
