# argon2id-wasm

> [!WARNING]
> This package exists for [Convex Auth](https://github.com/get-convex/convex-auth).
> Use outside of Convex Auth is not supported at the moment: the API can change at
> any time, and we can't help with other setups.

Argon2id password hashing for JavaScript. This is a thin wrapper around the Rust
[`argon2`](https://docs.rs/argon2) crate, compiled to WebAssembly with `wasm-bindgen`.

```ts
import { hashPassword, verifyPassword } from "argon2id-wasm";

const phc = await hashPassword("correct horse battery staple");
const ok = await verifyPassword("correct horse battery staple", phc);
```

`hashPassword` returns a PHC string with the salt and parameters embedded.

See [rust/README.md](https://github.com/get-convex/convex-auth/blob/reboot/packages/argon2id-wasm/rust/README.md)
to build the WASM bindings.
