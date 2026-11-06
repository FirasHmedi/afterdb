# Security

Report vulnerabilities privately by email to hello@pomwik.com, not in a public issue. We reply within 2 working days.

Known: the Android build links OpenSSL 3.3.1 (bundled from the upstream archives), end-of-life since 2026-04-09.
Moving to OpenSSL 3.5 LTS is planned. iOS uses the system CommonCrypto. realm-core itself is the upstream prebuilt
engine: we do not patch it, and we have not found a published CVE for it.
