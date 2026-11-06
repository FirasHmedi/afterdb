# Independent review tests

Written by an independent reviewer on 2026-11-06 (no shared context with the author, told to find faults). The
tests that showed a defect were updated after each fix, so they now check that the fix holds; each updated test says
so in a comment.

Run after `npm run build`, `cd converter && npm install`, and with the Android NDK installed (16 KB tests):

```bash
review/run-all.sh
```
