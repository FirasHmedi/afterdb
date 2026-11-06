# Security

This covers `@pomwik/afterdb`, an independent fork of the open-source Realm® JavaScript SDK v20 (realm-js), and
`@pomwik/afterdb-react`. Realm® is a trademark of MongoDB, Inc.; this project is not affiliated with or endorsed by
MongoDB.

Report vulnerabilities privately by email to hello@pomwik.com, not in a public issue. We reply within 12 hours.

The Android build links OpenSSL 3.5.9 LTS (built from the official source release, SHA-256 checked), instead
of the end-of-life 3.3.1 that upstream downloads at compile time. The SHA-256 of each bundled OpenSSL archive is
recorded in the package's CMake files, and the Android build stops if the archive does not match. We follow 3.5.x
security releases. iOS uses the system CommonCrypto. realm-core itself is the upstream prebuilt engine: we do not
patch it, and we have not found a published CVE for it.
