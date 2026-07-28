/**
 * A keyed, subscribable value store scoped to one `AuthClient` instance.
 *
 * Provider clients keep their shared client-side state here — actions
 * registered at setup time, flow state like an OAuth error code — so their
 * hooks can read it from any component without a dedicated React context.
 * Values are replaced, never mutated, so a read is a stable snapshot for
 * `useSyncExternalStore`.
 */
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
