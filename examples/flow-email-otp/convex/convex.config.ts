import { defineApp } from "convex/server";

const app = defineApp();

// TODO(auth-v2): mount the auth components (and their env bindings) once the
// v2 surface exists. This fixture intentionally leaves the wiring open — the
// aspirational app-level API lives in ./auth.ts.

export default app;
