/**
 * API Key crypto utilities.
 *
 * Uses `@oslojs/crypto` primitives for key generation and hashing:
 * - SHA-256 for hashing keys (API keys have high entropy, no need for bcrypt)
 * - Cryptographically secure random generation for key material
 *
 * @module
 */

import type { ApiKeySecret, Hashed } from "../shared/brand";
import { sha256, generateRandomString } from "./random";
import type { KeyScope, ScopeChecker } from "./types";

const DEFAULT_KEY_PREFIX = "sk_";
const KEY_RANDOM_LENGTH = 32;
const KEY_RANDOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * How many characters of the full key to store as the visible prefix.
 * Includes the prefix string (e.g. "sk_") plus a few random chars.
 */
const VISIBLE_PREFIX_EXTRA_CHARS = 4;

/**
 * Generate a new API key.
 *
 * Returns the raw key (to be shown once to the user) and metadata for storage.
 * The raw key is `{prefix}{32 random alphanumeric chars}`.
 *
 * @param prefix - Key prefix, defaults to "sk_"
 * @returns `{ raw, hashedKey, displayPrefix }`
 */
/** @internal */
export async function generateApiKey(prefix: string = DEFAULT_KEY_PREFIX): Promise<{
  /** The full raw key — show to user once, never store. */
  raw: ApiKeySecret;
  /** SHA-256 hex hash of the raw key — store this. */
  hashedKey: Hashed<"ApiKeySecret">;
  /** Truncated prefix for display (e.g. "sk_aBc1..."). */
  displayPrefix: string;
}> {
  const randomPart = generateRandomString(KEY_RANDOM_LENGTH, KEY_RANDOM_ALPHABET);
  const raw = `${prefix}${randomPart}` as ApiKeySecret;
  const hashedKey = (await sha256(raw)) as Hashed<"ApiKeySecret">;
  const displayPrefix = `${raw.substring(0, prefix.length + VISIBLE_PREFIX_EXTRA_CHARS)}...`;

  return { raw, hashedKey, displayPrefix };
}

/**
 * Hash a raw API key for lookup.
 *
 * Used during Bearer token verification to find the stored key record.
 */
/** @internal */
export async function hashApiKey(rawKey: string): Promise<Hashed<"ApiKeySecret">> {
  return (await sha256(rawKey)) as Hashed<"ApiKeySecret">;
}

/**
 * Build a `ScopeChecker` from an array of `KeyScope` entries.
 *
 * The checker provides a `.can(resource, action)` method that returns `true`
 * if any scope entry grants the requested permission.
 *
 * A wildcard action `"*"` grants all actions on that resource.
 * A wildcard resource `"*"` grants the action on all resources.
 */
/** @internal */
export function createScopeChecker(scopes: KeyScope[]): ScopeChecker {
  return {
    scopes,
    can(resource: string, action: string): boolean {
      return scopes.some(
        (scope) =>
          (scope.resource === resource || scope.resource === "*") &&
          (scope.actions.includes(action) || scope.actions.includes("*")),
      );
    },
  };
}
