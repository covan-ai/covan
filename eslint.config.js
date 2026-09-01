import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `.claude/worktrees/**` holds nested git worktrees: other checkouts of this
    // same project (e.g. `.claude/worktrees/agent-routines`, branch
    // `feat/routines-ui`, already merged). Linting them re-lints files that are
    // not part of this working tree and double-reports every real finding.
    // `.output`/`.vinxi`/`.wrangler`/`.vercel`/`.nitro`/`.tanstack` are build
    // output and tool scratch directories, not source.
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      ".wrangler",
      ".vercel",
      ".nitro",
      ".tanstack",
      ".claude/worktrees/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // `eslint-plugin-react-hooks` 7 brought the React Compiler rules into
      // `recommended`: two rules became sixteen. Fourteen of them pass, and the
      // two that did not — `static-components` and `refs` — were fixed rather
      // than silenced, because each was one site and each was a real defect.
      //
      // This one is different, and the difference is worth writing down. It
      // reports eleven sites, and every one of them is the same shape: read
      // something that only exists in a browser — `matchMedia`, `localStorage`,
      // the theme the init script chose, a form field seeded from a query that
      // resolves a beat after first render — and put it into state after mount.
      // The rule is right that this costs a second render, and right that
      // `useSyncExternalStore` is the answer for most of them. It is a
      // behavioural refactor of eleven call sites across the chat, settings,
      // theme and onboarding surfaces, and it does not belong in the commit
      // that upgrades the plugin: a dependency bump that quietly rewrites how
      // the theme loads is a dependency bump nobody can review.
      //
      // A warning, not off, so the count stays visible and a twelfth site
      // announces itself. The eleven are enumerated in covan#68.
      "react-hooks/set-state-in-effect": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // This was a warning, with a note calling the `any` sites known debt and
      // saying to re-tighten once they were paid down. In application and API
      // code they are: the last of them were the Supabase client threaded
      // through `lib/routines/` as `any`, which is now `SupabaseClient` — the
      // type the rest of the codebase already used — and the XML feed parser,
      // which is `unknown` behind two narrowing helpers.
      //
      // An error, not a warning, because the point of paying a debt down is not
      // having to do it twice.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Tests are the exception, and it is not debt. A mock exists to be the
    // shape the code under test happens to touch — three methods of a Supabase
    // client, a fetch that returns one canned response — and writing that as a
    // real type means either implementing an interface the test does not use or
    // casting through `unknown`, which is `any` with more steps. The types that
    // matter are on the thing being tested; these are the scaffolding.
    files: ["**/*.test.{ts,tsx}", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // Same argument, for a rule that arrived with react-hooks 7. A test
      // harness component exists to hand its innards back to the test —
      // `mermaid-blocks.test.tsx` renders a div, keeps a ref to it, and passes
      // that ref out through an `onRef` prop so the assertions can reach the
      // DOM the component under test is given. That is a callback during
      // render, which `react-hooks/refs` reports and is right to report in
      // application code. Here the alternative is an effect that fires after
      // the child has already rendered, which is later than the test needs it.
      "react-hooks/refs": "off",
    },
  },
  {
    // Every file here is the same shape, and the framework decides that shape:
    // `export const Route = createFileRoute(...)` plus the component it renders,
    // defined locally in the same file. That is what `bun run dev` generates and
    // what `routeTree.gen.ts` expects to find.
    //
    // eslint-plugin-react-refresh 0.5 began reporting it — 3 warnings became 38,
    // one per route. `allowExportNames: ["Route"]` does not help, and it is
    // worth knowing why rather than trying it again: 0.5 flags the *local*
    // components, not the export. Its complaint is "this file's only export is
    // not a component, so move the components out", which no allowlist of export
    // names can answer.
    //
    // The rule is not wrong about the mechanism — fast refresh really is worse
    // for these files. It is wrong about the remedy, which would be 34 route
    // files split in two to satisfy a dev-server nicety. Off here; still on for
    // `src/components/` and `src/lib/`, where the choice is actually ours.
    files: ["src/routes/**"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // Vendored, not authored: `src/components/ui/` is what `shadcn add` writes.
    // Its components ship next to their `cva` variants and a few helper hooks
    // in one file, which is the upstream shape — so this rule fires on almost
    // all of them, and the only way to satisfy it is to diverge from the
    // generator and re-diverge after every update. Off here, on everywhere else.
    files: ["src/components/ui/**"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  eslintPluginPrettier,
);
