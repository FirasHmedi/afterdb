# Releasing (done by Firas only)

1. Pick the final package names (placeholders: `@pomwik/keelstore`, `@pomwik/keelstore-react`). Change `NAME` in
   `bridge/build.mjs` and `react/build.mjs`, and the names in the READMEs and `example/package.json`.
2. `npm run build && npm test` (and the converter: `cd converter && npm test`).
3. Check the CI is green on GitHub (Android build, 16 KB check, iOS build).
4. Publish from the built folders, with provenance from the CI or locally:
   ```bash
   cd bridge/out/work/package && npm publish --access public --provenance
   cd react/out/work/package && npm publish --access public --provenance
   ```
5. Tag the commit: `git tag v20.3.0 && git push --tags`.

Nothing in this repository publishes automatically.
