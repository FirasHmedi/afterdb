# Releasing (done by Firas only)

1. Pick the final package names (placeholders: `@pomwik/keelstore`, `@pomwik/keelstore-react`). Change `NAME` in
   `bridge/build.mjs` and `react/build.mjs`, and the names in the READMEs and `example/package.json`.
2. On a clean checkout: `bridge/openssl/build-openssl.sh` first (Android NDK 27.*), then
   `npm run build && npm test`, `node --test scripts/check-16kb.test.mjs` and `cd converter && npm test`.
   The build stops if a pinned hash does not match (npm integrity of `realm` and `@realm/react`, SHA-256 of the
   5 Node binaries, of the OpenSSL source and of the upstream 3.3.1 archive whose `include.cmake` is reused).
3. Check the CI is green on GitHub (Android build, 16 KB check, iOS build). It has never been green yet: do not
   publish before it is.
4. Publish from the built folders, with provenance from the CI or locally:
   ```bash
   cd bridge/out/work/package && npm publish --access public --provenance
   cd react/out/work/package && npm publish --access public --provenance
   ```
5. Tag the commit: `git tag v20.3.0 && git push --tags`.

Nothing in this repository publishes automatically.
