#!/usr/bin/env bash
# Independent review tests. Needs: `npm run build` done, `cd converter && npm install` done, Android NDK for check16kb.
set -euo pipefail
cd "$(dirname "$0")/.."
node --test review/patches.test.mjs
node --test review/install.test.mjs
node --test review/node-api.test.mjs
node --test review/check16kb.test.mjs
node --test --test-concurrency=1 review/converter-adversarial.test.mjs
