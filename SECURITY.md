# Security

Report vulnerabilities privately by email to hello@pomwik.com, not in a public issue. We reply within 2 working days.

The Android build links OpenSSL 3.5.9 LTS (built from the official source release, SHA-256 checked), instead
of the end-of-life 3.3.1 that upstream downloads at compile time. We follow 3.5.x security releases. iOS uses the system CommonCrypto. realm-core itself is the upstream prebuilt
engine: we do not patch it, and we have not found a published CVE for it.
