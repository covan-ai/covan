import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Deliberately standalone. vite.config.ts loads TanStack Start + nitro, which
// fails under a test process. Vitest prefers this file when it is present, so
// the app config is never read here. The alias below has to mirror tsconfig's "@/*".
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // scripts/ is in here for web-runtime-config.mjs, which runs inside the
    // published Docker image rather than in the app, and is the one script whose
    // failure mode is a container that starts and quietly does not work. It
    // opts into the node environment with a docblock; everything under src/
    // wants jsdom.
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
});
