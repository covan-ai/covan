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
    ...(command === "build"
      ? [
          nitro({
            defaultPreset: "node-server",
            // Pins Rolldown's own runtime helpers to a chunk of their own.
            //
            // This is not a size or caching tweak. Without it the build emits
            // a server that throws `__exportAll is not a function` on every
            // request — see #101, which is what nine days of a dead self-host
            // build cost before anyone traced it.
            //
            // There are two Rolldown passes here, and only the second one is
            // wrong. Vite's SSR build already gets this right: it emits
            // `rolldown-runtime-*.js` as its own 360-byte chunk with no
            // imports at all. Nitro then re-chunks that output into
            // `.output/server/_ssr/`, and it is that pass which merged the
            // runtime helper into a chunk that also re-exported the server
            // entry's namespace. That chunk therefore imported the big server
            // chunk, while the big server chunk imported `__exportAll` back
            // out of it — a cycle. `__exportAll` is a `var`, so whichever side
            // Node evaluates second finds it hoisted and still `undefined`.
            // Hence a TypeError rather than a resolution failure, which is why
            // grepping for a missing file turns up nothing.
            //
            // A group with nothing else in it cannot import anything, so the
            // back-edge has nowhere to attach and the cycle cannot form.
            //
            // Nothing in our source is at fault, and that is the point worth
            // keeping: #101 bisected to `0f8c46e`, a commit about telling a
            // dead session apart from an unreachable one, which touches no
            // build configuration whatsoever. It merely moved the module graph
            // enough to tip the chunker over. Any commit could do that again,
            // in either direction, which is why the fix belongs here and not in
            // whatever module happens to be holding the graph today.
            rolldownConfig: {
              output: {
                codeSplitting: {
                  groups: [{ name: "rolldown-runtime", test: /rolldown-runtime/ }],
                },
              },
            },
          }),
        ]
      : []),
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
