// SDK objects hold native memory that V8 does not see, and it is released by
// finalizers that only run on the event loop. Long synchronous loops therefore
// grow RSS without bound. relax() forces a GC and yields so finalizers run.
//
// Signal handlers (Ctrl-C, SIGTERM: see bin/) also run only on the event loop.
// Long loops call `if (due()) await pause()`, which yields once every SLICE_MS,
// so an interrupt is handled within about that time (plus the current SQLite
// statement), whatever --batch is.
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

export const SLICE_MS = 50;
let last = performance.now();

/** True when the code has run for SLICE_MS without yielding. Cheap: call it often. */
export const due = () => performance.now() - last >= SLICE_MS;

/** Yields to the event loop (signal handlers, finalizers). */
export async function pause() {
  await tick();
  last = performance.now();
}

export async function relax() {
  if (gcFn) gcFn();
  await pause();
}
