# @convex-dev/passkey-test-authenticator

A minimal software WebAuthn authenticator. It builds the payloads of a
registration or an authentication ceremony (client data, authenticator data,
attestation objects) and signs assertions with real WebCrypto keys, so that a
test drives the passkey component with genuine ceremony bytes.

This package is private. It is a development dependency of the packages and the
example apps of this repository, and it is never published. `@convex-dev/auth`
does not depend on it, and it does not depend on `@convex-dev/auth`: it knows
the WebAuthn wire format, not the component.
