# Vendored Oslo libraries

This directory contains code vendored from the [Oslo
project](https://oslojs.dev) by pilcrowOnPaper. The Oslo project is being
deprecated, so the parts that the passkey component relies on live here
instead of coming in as npm dependencies.

All of the code is MIT-licensed, Copyright (c) 2024 pilcrowOnPaper (see the
`LICENSE` file in this directory).

<!-- TODO(nicolas) Consider whether we should consider using another library instead of vendoring Oslo -->

## Sources

Each directory mirrors one Oslo package, and the file layout follows the
package's public import specifiers (for example `@oslojs/crypto/ecdsa`
becomes `crypto/ecdsa.ts`).

| Directory   | Source package     | Version | Commit    | Repository                               |
| ----------- | ------------------ | ------- | --------- | ---------------------------------------- |
| `webauthn/` | `@oslojs/webauthn` | 1.0.0   | `c18f664` | https://github.com/oslo-project/webauthn |
| `crypto/`   | `@oslojs/crypto`   | 1.0.1   | `8b3910f` | https://github.com/oslo-project/crypto   |
| `asn1/`     | `@oslojs/asn1`     | 1.0.0   | `65a9bbd` | https://github.com/oslo-project/asn1     |
| `binary/`   | `@oslojs/binary`   | 1.0.0   | `9186bf7` | https://github.com/oslo-project/binary   |
| `cbor/`     | `@oslojs/cbor`     | 1.0.0   | `0ec853c` | https://github.com/oslo-project/cbor     |
| `encoding/` | `@oslojs/encoding` | 1.1.0   | `5b8b873` | https://github.com/oslo-project/encoding |

## Modifications

- Each package module is merged into a single file, and the pieces the
  passkey component does not use are removed (for example other hash
  functions, other elliptic curves, RSA-PSS, CBOR encoding, ASN.1 types that
  never appear in WebAuthn payloads, and the COSE key types the component
  rejects).
- The tests are ported into `*.test.ts` files next to the sources so they run
  with the repository's Vitest setup. Tests that used `node:crypto` were
  rewritten against the WebCrypto API (the tests run in an edge-like runtime,
  like Convex functions). The NIST signature- and hash-verification vectors
  from the `@oslojs/crypto` repository are ported for the algorithms kept here
  (SHA-256, ECDSA P-256, RSASSA-PKCS1-v1.5) in `crypto/nist-vectors.test.ts`.
- Bug fix in `crypto/ecdsa.ts`: `ECDSAPublicKey.encodeSEC1Uncompressed()` wrote
  the `y` coordinate left-aligned in its slot. A coordinate smaller than 2^248
  (about 1 key in 256) was therefore shifted and padded with trailing zeroes,
  which made every signature check with that key fail.

When changing this code, keep the changes minimal and covered by the tests.
