import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";

// This config is deliberately explicit so the project builds with nothing but
// its own open-source dependencies, and so the nitro target can be chosen per
// deployment rather than being fixed by the build tooling.
//
// The server target is resolved by nitro in this order:
//   NITRO_PRESET (shell/CI env) > auto-detected provider > defaultPreset below
// So a hosted build on Vercel or Netlify picks its own target with nothing set,
// a plain local `bun run build` produces a Node server under .output/ — which
// is what the Docker image runs — and NITRO_PRESET overrides either. This
// config only builds the frontend; the API worker is a separate package under
// worker/.
export default defineConfig(({ command }) => ({
  plugins: [
    // Scoped to this package: without `projects` the plugin crawls the whole
    // workspace and picks up worker/tsconfig.json and any git worktrees.
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      // src/server.ts wraps the generated SSR entry to render an error page.
      server: { entry: "server" },
    }),
    // Nitro turns the SSR build into a deployable server. It is build-only:
    // in dev, Vite serves SSR itself and adding nitro here would fight it.
    ...(command === "build" ? [nitro({ defaultPreset: "node-server" })] : []),
    viteReact(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // Do not remove. Every package below keeps module-scoped state that breaks
    // if it is resolved twice — which happens as soon as a transitive
    // dependency pulls in its own copy. React fails with "invalid hook call";
    // the router and React Query lose their context and report a missing
    // provider. Nothing in the build catches any of it; it only shows up when a
    // page renders. List package names only — Vite reduces a deep import like
    // react/jsx-runtime to its package name before consulting this list, so
    // "react" already covers every subpath.
    dedupe: [
      "react",
      "react-dom",
      "@tanstack/react-router",
      "@tanstack/react-start",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  server: { port: 3000 },
}));
