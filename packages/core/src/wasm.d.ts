// The password component imports `@convex-dev/argon2id`, whose source imports a
// `.wasm` module. This ambient declaration lets this package's `tsc` program
// type that import when it follows into the dependency's source. (`argon2id`
// ships its own copy for its own typecheck.)
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
