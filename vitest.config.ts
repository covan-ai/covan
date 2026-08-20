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
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
