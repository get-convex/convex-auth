import { describe, expect, test, vi } from "vitest";
import { KeyedStore } from "./keyedStore";

describe("KeyedStore", () => {
  test("get returns undefined for a missing key", () => {
    const store = new KeyedStore();
    expect(store.get("missing")).toBeUndefined();
  });

  test("set stores a value and get reads it back", () => {
    const store = new KeyedStore();
    store.set("greeting", "hello");
    expect(store.get<string>("greeting")).toBe("hello");

    store.set("greeting", "hi again");
    expect(store.get<string>("greeting")).toBe("hi again");
  });

  test("set notifies that key's subscribers", () => {
    const store = new KeyedStore();
    const listener = vi.fn();
    store.subscribe("greeting", listener);

    store.set("greeting", "hello");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("set does not notify other keys' subscribers", () => {
    const store = new KeyedStore();
    const listener = vi.fn();
    store.subscribe("other", listener);

    store.set("greeting", "hello");
    expect(listener).not.toHaveBeenCalled();
  });

  test("unsubscribing stops notifications", () => {
    const store = new KeyedStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe("greeting", listener);

    store.set("greeting", "hello");
    unsubscribe();
    store.set("greeting", "hi again");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
