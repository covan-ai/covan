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
