# Security

This covers `@pomwik/afterdb`, an independent fork of the open-source Realm® JavaScript SDK v20 (realm-js), and
`@pomwik/afterdb-react`. Realm® is a trademark of MongoDB, Inc.; this project is not affiliated with or endorsed by
MongoDB.

Report vulnerabilities privately by email to hello@pomwik.com, not in a public issue. We reply within 12 hours.

The Android build links OpenSSL 3.5.9 LTS (built from the official source release, SHA-256 checked), instead of the
end-of-life 3.3.1 that upstream downloads at compile time. The SHA-256 of each bundled OpenSSL archive is recorded in
the package's CMake files, and the Android build stops if the archive does not match. 3.5.9 is the newest 3.5.x
release on 2026-11-10. When a 3.5.x release fixes a security issue, we plan to ship it in a new afterdb version (see
the [Maintenance policy](README.md#maintenance-policy)). Today nothing alerts us to a new OpenSSL release
automatically. iOS uses the system CommonCrypto.

The Node binaries (`prebuilds/node/`) are upstream's, unchanged: byte-identical to the ones `realm@20.2.0` downloads
from static.realm.io (the package's `checksums.txt` lists the SHA-256 of the upstream archives they come from). On
Linux (x64 and arm64) they contain OpenSSL built from the 3.3.1 sources, end-of-life since 2026-04-09:
`strings prebuilds/node/linux-x64/realm.node | grep nssl-3.3.1` shows its source paths. We cannot rebuild these
binaries yet. On macOS they use the system CommonCrypto, and on Windows the system BCrypt library.

realm-core itself is the upstream prebuilt engine: we do not change its compiled libraries (one shipped header and the
Android CMake files that acquire OpenSSL are patched, see `CHANGES-FROM-UPSTREAM.md`), and we have not found a
published CVE for it.
