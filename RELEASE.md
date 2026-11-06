# Releasing (done by Firas only)

Packages: `@pomwik/afterdb` 20.3.0 (from `realm@20.2.0`) and `@pomwik/afterdb-react` 0.20.1 (from
`@realm/react@0.20.0`). `npm run build` writes `bridge/out/pomwik-afterdb-20.3.0.tgz` and
`react/out/pomwik-afterdb-react-0.20.1.tgz`; the names and versions are `NAME` and `VERSION` in `bridge/build.mjs`
and `react/build.mjs`.

1. On a clean checkout: `bridge/openssl/build-openssl.sh` first (Android NDK 27.*), then
   `npm run build && npm test`, `node --test scripts/check-16kb.test.mjs` and `cd converter && npm test`.
   The build stops if a pinned hash does not match (npm integrity of `realm` and `@realm/react`, SHA-256 of the
   5 Node binaries, of the OpenSSL source and of the upstream 3.3.1 archive whose `include.cmake` is reused).
2. Check the CI is green on GitHub for the commit you publish (Android build, 16 KB check, and the iOS jobs, which
   only run when started by hand). Do not publish before it is.
3. Check which registry npm will publish to. A `@pomwik:registry=...` line in any `.npmrc` (the project's,
   `~/.npmrc` or the global one) wins over `--registry` for every `@pomwik/*` package: a local test registry left
   there (Verdaccio, for example) would receive the release instead of npmjs.com.
   ```bash
   npm config get @pomwik:registry      # must print undefined or https://registry.npmjs.org/
   cd bridge/out/work/package && npm publish --dry-run --access public
   ```
   The dry run must say « Publishing to https://registry.npmjs.org/ ». If it names another registry, remove the
   `@pomwik:registry` line first.
4. Publish both packages, `--access public` (scoped packages are private by default on their first publish):
   ```bash
   cd bridge/out/work/package && npm publish --access public --provenance
   cd react/out/work/package && npm publish --access public --provenance
   ```
   `--provenance` does not work from a laptop. npm generates provenance only when publishing from a supported cloud
   CI/CD provider (docs.npmjs.com/generating-provenance-statements):
   - GitHub Actions on a GitHub-hosted runner (or GitLab CI/CD on GitLab.com shared runners); self-hosted runners
     are not supported;
   - the job has `permissions: id-token: write` (and `contents: read`), so it can request an OIDC token;
   - npm CLI 9.5.0 or later, and an npm token as a secret (`NODE_AUTH_TOKEN` with `actions/setup-node` and
     `registry-url: https://registry.npmjs.org`). With a trusted publisher configured on npmjs.com instead of a
     token (npm CLI 11.5.1 or later, Node 22.14.0 or later), provenance is added without `--provenance`;
   - `repository.url` in each `package.json` matches the GitHub repository of the workflow: `bridge/build.mjs` writes
     `git+https://github.com/FirasHmedi/afterdb.git` in both packages;
   - **the repository must be public**: « Provenance generation is not supported for private repositories, even
     when publishing public packages » (docs.npmjs.com/trusted-publishers). FirasHmedi/afterdb is private today:
     make it public before the release, or publish without `--provenance`.

   No release workflow exists yet: it would build OpenSSL and the packages as the CI does, then run the two
   commands above in the same job.
5. Tag the commit: `git tag v20.3.0 && git push --tags`.
6. Apps that were installed from a local test registry must regenerate their lockfile: `package-lock.json` (or
   `yarn.lock`, `pnpm-lock.yaml`) records the test registry's URL (`http://localhost:...`) and the integrity of the
   test tarball, which differs from the published one. Delete the lockfile and `node_modules`, remove the
   `@pomwik:registry` line, and reinstall from npmjs.com.

Nothing in this repository publishes automatically.
