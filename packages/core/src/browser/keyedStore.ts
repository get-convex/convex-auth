/**
 * A keyed, subscribable value store scoped to one `AuthClient` instance.
 *
 * Ambient sign-ins publish here what their hooks need to read (the actions
 * registered at setup time, and status like an OAuth error code), so any
 * component can read it without a dedicated React context. Values are
 * replaced, never mutated, so a read is a stable snapshot for
 * `useSyncExternalStore`.
 *
 * @module
 */
/**
 * A read/write view over a {@link KeyedStore} with every key prefixed, the
 * shape handed to an ambient sign-in's setup. Subscriptions stay on the full
 * store, by full key.
 */
export type SignInValues = {
  /** Read the value at `key` within the scope. */
  get<T>(key: string): T | undefined;
  /** Replace the value at `key` within the scope. */
  set<T>(key: string, value: T): void;
};

/**
 * A read-only view over a {@link KeyedStore} with every key prefixed, the
 * shape hooks and other bindings read an ambient sign-in's values through.
 * Writes only happen through the {@link SignInValues} a setup receives.
 */
export type SignInValuesReader = {
  /** Read the value at `key` within the scope. */
  get<T>(key: string): T | undefined;
  /**
   * Subscribe to changes of the value at `key` within the scope. Returns an
   * unsubscribe function.
   */
  subscribe(key: string, listener: () => void): () => void;
};

/** The full store key for `key` within the scope named `prefix`. */
function scopedKey(prefix: string, key: string): string {
  return `${prefix}/${key}`;
}

export class KeyedStore {
  readonly #values = new Map<string, unknown>();
  readonly #listeners = new Map<string, Set<() => void>>();

  /** Read the value at `key`, or `undefined` when nothing is registered. */
  get<T>(key: string): T | undefined {
    return this.#values.get(key) as T | undefined;
  }

  /** Replace the value at `key` and notify that key's subscribers. */
  set<T>(key: string, value: T): void {
    this.#values.set(key, value);
    for (const listener of this.#listeners.get(key) ?? []) {
      listener();
    }
  }

  /**
   * A {@link SignInValues} over this store, mapping `key` to
   * `${prefix}/${key}`.
   */
  forSignIn(prefix: string): SignInValues {
    return {
      get: <T>(key: string): T | undefined =>
        this.get<T>(scopedKey(prefix, key)),
      set: <T>(key: string, value: T): void => {
        this.set(scopedKey(prefix, key), value);
      },
    };
  }

  /**
   * A {@link SignInValuesReader} over this store, mapping `key` to
   * `${prefix}/${key}`.
   */
  forSignInReader(prefix: string): SignInValuesReader {
    return {
      get: <T>(key: string): T | undefined =>
        this.get<T>(scopedKey(prefix, key)),
      subscribe: (key: string, listener: () => void): (() => void) =>
        this.subscribe(scopedKey(prefix, key), listener),
    };
  }

  /**
   * Subscribe to changes of the value at `key`. Returns an unsubscribe
   * function. Subscribers should read the new value via {@link get} when
   * notified.
   */
  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(key) ?? new Set();
    this.#listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
}
