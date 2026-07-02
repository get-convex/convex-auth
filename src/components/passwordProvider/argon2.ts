import init, {
  hash_password,
  verify_password,
} from "./rust-argon2/_generated/argon2_wasm.js";
import wasmModule from "./rust-argon2/_generated/argon2_wasm_bg.wasm"; // WebAssembly.Module (Convex wasmPlugin)

// The wasm-bindgen module must be instantiated once before its exports can be
// called. Memoize the promise so concurrent calls share a single init.
let ready: Promise<unknown> | null = null;
function ensureReady() {
  if (!ready) ready = init({ module_or_path: wasmModule }); // WebAssembly.instantiate(module, imports)
  return ready;
}

/** Hash a password with argon2id, returning a PHC string (salt + params embedded). */
export async function hashPassword(password: string): Promise<string> {
  await ensureReady();
  const salt = crypto.getRandomValues(new Uint8Array(16)); // randomness stays in JS
  return hash_password(password, salt);
}

/** Verify a password against a stored PHC string. */
export async function verifyPassword(
  password: string,
  phc: string,
): Promise<boolean> {
  await ensureReady();
  return verify_password(password, phc);
}
