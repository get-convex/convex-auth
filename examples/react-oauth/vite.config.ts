import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite configuration for the OAuth example app.
 *
 * Uses the React plugin for JSX/Fast Refresh and the Tailwind v4 plugin,
 * which handles CSS processing without a separate PostCSS or Tailwind config.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
