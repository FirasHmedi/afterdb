// SDK objects hold native memory that V8 does not see, and it is released by
// finalizers that only run on the event loop. Long synchronous loops therefore
// grow RSS without bound. relax() forces a GC and yields so finalizers run.
import v8 from 'node:v8';
import vm from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';

let gcFn = globalThis.gc;
if (typeof gcFn !== 'function') {
  try {
    v8.setFlagsFromString('--expose-gc');
    gcFn = vm.runInNewContext('gc');
  } catch {
    gcFn = null;
  }
}

export async function relax() {
  if (gcFn) gcFn();
  await tick();
}
