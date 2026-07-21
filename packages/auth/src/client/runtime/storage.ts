import { LOG_LEVELS, logMessage } from "../../shared/log";
import type { Storage } from "../core/types";

/**
 * How many times a write/remove is attempted before giving up. Runtime stores
 * such as Expo SecureStore can throw transiently; a failed delete on sign-out
 * that is silently swallowed would leave the token on disk and boot the next
 * launch signed in, so the security-critical mutations retry once.
 */
const STORAGE_MUTATION_ATTEMPTS = 2;

/** @internal */
export function createStorageHelpers(args: {
  storage: Storage | null;
  key: (name: string) => string;
}) {
  const { storage, key } = args;

  const get = async (name: string): Promise<string | null> => {
    if (!storage) {
      return null;
    }
    try {
      return (await storage.getItem(key(name))) ?? null;
    } catch (error) {
      logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
        `[convex-auth] Failed to read ${name} from storage:`,
        error,
      ]);
      return null;
    }
  };

  const set = async (name: string, value: string): Promise<boolean> => {
    if (!storage) {
      return true;
    }
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= STORAGE_MUTATION_ATTEMPTS; attempt++) {
      try {
        await storage.setItem(key(name), value);
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
      `[convex-auth] Failed to write ${name} to storage after ${STORAGE_MUTATION_ATTEMPTS} attempts:`,
      lastError,
    ]);
    return false;
  };

  const remove = async (name: string): Promise<boolean> => {
    if (!storage) {
      return true;
    }
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= STORAGE_MUTATION_ATTEMPTS; attempt++) {
      try {
        await storage.removeItem(key(name));
        lastError = null;
      } catch (error) {
        lastError = error;
        continue;
      }
      // Best-effort verification: if the backend can be read back and still
      // holds a value, treat the delete as failed and retry so a persisted
      // token cannot survive sign-out.
      try {
        if ((await storage.getItem(key(name))) == null) {
          return true;
        }
        lastError = new Error(`Storage key still present after removeItem: ${name}`);
      } catch {
        // Verification read failed; assume the delete stuck.
        return true;
      }
    }
    logMessage("convex-auth/client", LOG_LEVELS.ERROR, [
      `[convex-auth] Failed to remove ${name} from storage after ${STORAGE_MUTATION_ATTEMPTS} attempts:`,
      lastError,
    ]);
    return false;
  };

  return { get, set, remove };
}
