# Releasing (maintainers)

Packages: `@pomwik/afterdb` (from `realm@20.2.0`) and `@pomwik/afterdb-react` (from `@realm/react@0.20.0`). Their
names and versions are `NAME` and `VERSION` in `bridge/build.mjs` and `react/build.mjs`.

20.3.0 and 0.20.1, the versions on npm today, were published from a laptop and have no provenance
(`npm view @pomwik/afterdb@20.3.0 dist.attestations` prints nothing). From the next version on, only
`.github/workflows/publish.yml` publishes. Do not publish from a laptop.

## Steps

1. Bump `VERSION` in `bridge/build.mjs` and/or `react/build.mjs`. The tarball names also appear in
   `.github/workflows/ci.yml` (converter tests, `ios-rn` job), `bridge/test/bridge.test.mjs`,
   `review/install.test.mjs`, `review/node-api.test.mjs`, `example/package.json` and `examples/expo-58/package.json`,
   and the versions in the READMEs.
2. Merge to `main` and wait for the CI run of that push to pass. A push to `main` runs every job: packages and tests,
   Android builds, the emulator runs, and the iOS builds and simulator runs (8 macOS jobs). A commit that only changes
   Markdown files or `docs/` starts no CI run (except the 4 Markdown files listed under "CI: which jobs run when"):
   then start CI by hand on `main` (Actions, CI, Run workflow) with `ios` and `emulators` checked (the defaults).
3. Optional: run Publish by hand on `main` with `dry_run` checked (the default), and read the log.
4. Publish a GitHub release whose tag (`v<version>`, for example `v20.3.1`) points at that commit. The Publish
   workflow starts and:
   - stops unless a CI run on the same commit succeeded with every job run: a push run, or a manual run with `ios`
     and `emulators` checked (a manual run that skipped jobs does not count);
   - installs npm 11.21.1 and Android NDK 27.3.13750724;
   - builds OpenSSL from source, without any cache; each of the 4 archives must match the SHA-256 pinned in
     `bridge/openssl/build-openssl.sh`;
   - builds both packages and runs `npm test`;
   - prints the SHA-256 of the 4 OpenSSL archives and of both tarballs, in the log and in the run summary (copy them
     into the release notes);
   - stages each version that is not on npm yet (`npm stage publish`, with provenance). Versions already on npm are
     skipped, so a re-run is harmless.
5. Approve each staged version with 2FA: npmjs.com, Staged Packages, or `npm stage list` then `npm stage approve <id>`
   (npm 11.15 or later). npm may hold a large new version for review for some minutes (a `0.0.0-stage` placeholder
   shows meanwhile).
6. Check the provenance: `npm view @pomwik/afterdb@<version> dist.attestations` must print something. Not tested
   yet: no version has gone through this workflow so far.

## Trusted publisher on npmjs.com (Firas only)

The workflow stores no npm token. It works only if both packages, `@pomwik/afterdb` and `@pomwik/afterdb-react`,
list it as trusted publisher: package Settings, Trusted Publisher, GitHub Actions, user `FirasHmedi`, repository
`afterdb`, workflow `publish.yml`, no environment, allowed action `npm stage publish` only. It was set up on
2026-11-08, and npm asked for a first staged publish before 2026-11-10 to validate it. If it has expired, add it
again on both packages before the next release. Without it, npm has no credentials and the stage step stops.

## CI: which jobs run when

- Pull requests: `packages`, `android`, `expo-android` (no emulator, no iOS).
- Pushes to `main`: every job, including the emulator runs and the 8 iOS jobs.
- By hand (Actions, CI, Run workflow): choose `ios`, `emulators` and `ios_set` (`min`: 4 macOS jobs, `all`: 8).
- Changes to Markdown files or `docs/` only: no run, except changes to `CHANGES-FROM-UPSTREAM.md`,
  `THIRD-PARTY-NOTICES.md`, `bridge/PACKAGE_README.md` or `react/PACKAGE_README.md`, which ship in the packages and
  are checked by `npm test`.

An emulator run is retried once, only when the emulator did not boot. A failed self-check on a booted emulator fails
the job.

## OpenSSL archives

`bridge/openssl/build-openssl.sh` builds OpenSSL for the 4 Android ABIs with NDK 27.3.13750724 (`NDK_VERSION`). It
is written to give reproducible archives: the build date comes from `SOURCE_DATE_EPOCH`, tar entries are sorted with
a fixed date, owner and mode, and gzip stores no name or time. For OpenSSL 3.5.9, two CI builds without cache on
GitHub's ubuntu-24.04 runners gave the same SHA-256 for the 4 archives (runs 42725544229 and 42725580288), and those
values are pinned in the script. A build on macOS is not tested yet to give the same bytes. The script checks each
archive against its pinned SHA-256: a cached archive that does not match is rebuilt, and a new build that does not
match stops the script.

To move to another NDK or OpenSSL version: change `NDK_VERSION` or the version table, empty the archive hashes,
build twice on CI without cache, check that both builds print the same SHA-256, then pin them.

`.github/workflows/openssl-watch.yml` runs every week and fails when an OpenSSL 3.5.x release newer than the
bundled one exists.

## Local build (tests only)

1. `bridge/openssl/build-openssl.sh` needs NDK 27.3.13750724 (`ANDROID_NDK_ROOT`, or
   `$ANDROID_HOME/ndk/27.3.13750724`). With another NDK, set `AFTERDB_OPENSSL_ANY_NDK=1`: the archives are built but
   not checked against the pinned SHA-256. With NDK 27.3.13750724 the script checks them, and the pinned values come
   from Linux CI builds: whether a macOS build matches them is not tested yet.
2. `npm run build && npm test`, `node --test scripts/check-16kb.test.mjs` and `cd converter && npm test`.

The build stops if a pinned hash does not match: npm integrity of `realm` and `@realm/react`, SHA-256 of the 5 Node
binaries, of the OpenSSL source, of the upstream 3.3.1 archive whose `include.cmake` is reused, and of the 4 OpenSSL
archives (not checked with `AFTERDB_OPENSSL_ANY_NDK=1`).

Apps installed from a local test registry (Verdaccio, for example) must regenerate their lockfile before they use
npmjs.com: `package-lock.json` (or `yarn.lock`, `pnpm-lock.yaml`) records the test registry's URL and the integrity
of the test tarball. Delete the lockfile and `node_modules`, remove any `@pomwik:registry` line from `.npmrc`, and
reinstall.

<!-- paths filter test (throwaway branch, not for merge) -->
