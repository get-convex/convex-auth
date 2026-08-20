/**
 * These tests cover the behavior of the `defaultStorage` function under
 * different environments. The default is what is used when no distinct
 * `storage` is passed in when configuring client-side Convex Auth.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  InMemoryStorage,
  defaultStorage,
  resetInMemoryFallbackWarning,
} from "./storage.js";

// The edge-runtime environment supplies its own `window` (=== globalThis), and
// we keep a reference to it here to restore it after each test (some of which
// set a new value for `window`).
const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, "window");

function setWindow(value: unknown): void {
  (globalThis as { window?: unknown }).window = value;
}

describe("defaultStorage", () => {
  beforeEach(() => {
    resetInMemoryFallbackWarning();
  });

  afterEach(() => {
    if (ORIGINAL_WINDOW === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW);
    }
    vi.restoreAllMocks();
  });

  test("uses localStorage in a browser", () => {
    const localStorage = new InMemoryStorage();
    setWindow({ localStorage });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(defaultStorage()).toBe(localStorage);
    expect(warn).not.toHaveBeenCalled();
  });

  test("falls back to memory silently on a server", () => {
    delete (globalThis as { window?: unknown }).window;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // In-memory is the right answer for a single server render, so this path
    // must stay quiet — otherwise every SSR request logs a warning.
    expect(defaultStorage()).toBeInstanceOf(InMemoryStorage);
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns once when a runtime has `window` but no localStorage", () => {
    // React Native's shape: sessions would silently vanish on app restart.
    setWindow({ navigator: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(defaultStorage()).toBeInstanceOf(InMemoryStorage);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/storage/);

    // A provider remount must not turn the hint into a repeating log.
    defaultStorage();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
