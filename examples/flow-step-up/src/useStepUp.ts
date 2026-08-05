import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { api } from "../convex/_generated/api";

type PendingReauth = {
  // The original sensitive call, retried automatically after re-auth.
  retry: () => Promise<void>;
  // Which auth methods can satisfy the step-up (from the server's error).
  methods: string[];
};

/**
 * Wraps sensitive calls. When a wrapped call throws ConvexError with
 * data.code === "REAUTH_REQUIRED", this opens re-auth modal state; a
 * successful reauthWithPassword automatically retries the original call —
 * the user never has to click the original button again.
 */
export function useStepUp() {
  const reauthWithPassword = useAction(api.auth.reauthWithPassword);
  const [pending, setPending] = useState<PendingReauth | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<void>) {
    try {
      await call();
    } catch (error) {
      if (
        error instanceof ConvexError &&
        (error.data as any)?.code === "REAUTH_REQUIRED"
      ) {
        setError(null);
        setPending({
          retry: call,
          methods: (error.data as any)?.methods ?? ["password"],
        });
        return;
      }
      throw error;
    }
  }

  async function submitPassword(password: string) {
    if (pending === null) {
      return;
    }
    setError(null);
    const result = await reauthWithPassword({ password });
    if (result.ok) {
      // Same session, same tokens — the WebSocket never blinked. Retry the
      // original call; it should now pass the server-side freshness guard.
      const { retry } = pending;
      setPending(null);
      await run(retry);
    } else {
      setError(
        result.code === "RATE_LIMITED"
          ? "Too many attempts. Try again shortly."
          : "Incorrect password.",
      );
    }
  }

  function cancel() {
    setPending(null);
    setError(null);
  }

  return {
    /** True when a re-auth modal should be shown. */
    needsReauth: pending !== null,
    /** Methods the server said can satisfy the step-up. */
    methods: pending?.methods ?? [],
    error,
    run,
    submitPassword,
    cancel,
  };
}
