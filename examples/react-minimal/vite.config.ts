import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev/build config for the example frontend. Tests use `vitest.config.ts`
// (Vitest prefers it over this file), so the two don't interfere.
export default defineConfig({
  plugins: [react()],
});
