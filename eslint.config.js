import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import i18next from "eslint-plugin-i18next";
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
      // This one arrived reporting eleven sites, which was too many to fix in
      // the commit that upgraded the plugin — a dependency bump that quietly
      // rewrites how the theme loads is a dependency bump nobody can review.
      // It sat at `warn` while covan#68 worked through them, and the rule was
      // right about nine: they read something that only exists in a browser —
      // `matchMedia`, `localStorage`, the theme the init script chose, a form
      // field seeded from a query — and copied it into state after mount.
      // `useSyncExternalStore`, a `key`, and in two cases deleting the effect
      // outright. One of them was a live bug rather than an extra render.
      //
      // `error` now, because the two that remain are not oversights and say so
      // where they are: `chat.tsx` sends a draft handed over from another
      // route, and `_authed.app.tsx` consumes a `?new=true` deep link. Both
      // carry a targeted disable and the reasoning for it. A twelfth site is
      // now a build failure, which is the right answer — the fix is either an
      // hour's work or a sentence explaining why it is the exception.
      "react-hooks/set-state-in-effect": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
            {
              name: "react-i18next",
              message:
                "Import useTranslation and Trans from @/i18n, which is what creates the instance they read.",
            },
          ],
          patterns: [
            {
              group: ["**/i18n/locales/*"],
              message:
                "The catalogues are read by src/i18n/resources.ts alone; a component gets its words from t().",
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
  {
    // The one file that is allowed to read the catalogues (see the
    // `no-restricted-imports` pattern above). The glob it uses is not an
    // import statement, so this is as much documentation as exemption.
    files: [
      "src/i18n/resources.ts",
      "src/i18n/index.ts",
      "src/i18n/provider.tsx",
      "src/test/in-turkish.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // Words in JSX go through `t()`. Scoped to the files that have been
    // translated, the same list `src/i18n/migrated.static.test.ts` keeps
    // for what this rule cannot see; it widens with every phase and
    // becomes `src/{components,routes}/**` when the last one lands.
    files: [
      "src/i18n/**/*.tsx",
      "src/components/sidebar/**/*.tsx",
      "src/components/app-shell.tsx",
      "src/components/top-bar.tsx",
      "src/components/banner.tsx",
      "src/components/banner-stack.tsx",
      "src/components/error-page.tsx",
      "src/components/empty-page.tsx",
      "src/components/command-palette.tsx",
      "src/components/feedback-dialog.tsx",
      "src/components/new-thread-button.tsx",
      "src/components/ui/dialog.tsx",
      "src/components/account/avatar-picker.tsx",
      "src/components/account/email-card.tsx",
      "src/components/account/password-card.tsx",
      "src/components/account/profile-form.tsx",
      "src/components/account/sessions-list.tsx",
      "src/components/account/sign-in-methods.tsx",
      "src/components/account/two-factor-card.tsx",
      "src/components/api-keys-section.tsx",
      "src/components/auth-layout.tsx",
      "src/components/browser-signins-section.tsx",
      "src/components/close-account-section.tsx",
      "src/components/coach-mark.tsx",
      "src/components/code-input.tsx",
      "src/components/coverage-notice.tsx",
      "src/components/create-agent-dialog.tsx",
      "src/components/credit-ledger.tsx",
      "src/components/credits-wall.tsx",
      "src/components/data-table.tsx",
      "src/components/export-workspace-section.tsx",
      "src/components/getting-started.tsx",
      "src/components/hbar-list.tsx",
      "src/components/inbox-row.tsx",
      "src/components/integrations/add-service-dialog.tsx",
      "src/components/integrations/app-catalogue.tsx",
      "src/components/integrations/app-detail-dialog.tsx",
      "src/components/integrations/composio-card.tsx",
      "src/components/integrations/connection-card.tsx",
      "src/components/integrations/connection-scope.tsx",
      "src/components/integrations/drive-folder-dialog.tsx",
      "src/components/integrations/slack-card.tsx",
      "src/components/integrations/tool-connection-card.tsx",
      "src/components/oauth-buttons.tsx",
      "src/components/open-browsers.tsx",
      "src/components/preferences-section.tsx",
      "src/components/quota-support-form.tsx",
      "src/components/recently-deleted-section.tsx",
      "src/components/revealed-secret.tsx",
      "src/components/routines/delivery-channels-card.tsx",
      "src/components/saved-logins.tsx",
      "src/components/sub-nav.tsx",
      "src/components/threads-table.tsx",
      "src/components/usage-section.tsx",
      "src/components/settings/memory-notes-section.tsx",
      "src/components/webhooks-section.tsx",
      "src/components/welcome/assistant-step.tsx",
      "src/components/welcome/first-docs-step.tsx",
      "src/components/welcome/invite-accept-step.tsx",
      "src/components/welcome/welcome-layout.tsx",
      "src/components/welcome/workspace-step.tsx",
      "src/components/workspace-coverage-section.tsx",
      "src/components/workspace-usage-section.tsx",
      "src/routes/_authed.app.tsx",
      "src/routes/_authed.inbox.tsx",
      "src/routes/_authed.settings.coverage.tsx",
      "src/routes/_authed.settings.export.tsx",
      "src/routes/_authed.settings.general.tsx",
      "src/routes/_authed.settings.integrations.tsx",
      "src/routes/_authed.settings.memory.tsx",
      "src/routes/_authed.settings.preferences.tsx",
      "src/routes/_authed.settings.profile.tsx",
      "src/routes/_authed.settings.security.tsx",
      "src/routes/_authed.settings.tsx",
      "src/routes/_authed.settings.usage.tsx",
      "src/routes/_authed.threads.tsx",
      "src/routes/_authed.welcome.tsx",
      "src/routes/_authed.arrivals.tsx",
      "src/routes/auth.callback.tsx",
      "src/routes/confirm-address.tsx",
      "src/routes/confirmed.tsx",
      "src/routes/forgot-password.tsx",
      "src/routes/index.tsx",
      "src/routes/invite.tsx",
      "src/routes/reset-password.tsx",
      "src/routes/sign-in.tsx",
      "src/routes/sign-up.tsx",
      "src/routes/two-factor.tsx",
      "src/components/agent-configuration-form.tsx",
      "src/components/agent-folders-dialog.tsx",
      "src/components/agent-knowledge.tsx",
      "src/components/agent-mark.tsx",
      "src/components/arrivals/**/*.tsx",
      "src/components/agent-steps.tsx",
      "src/components/agent-top-bar.tsx",
      "src/components/ask-bar.tsx",
      "src/components/avatar.tsx",
      "src/components/brand-mark.tsx",
      "src/components/chat-attach.tsx",
      "src/components/chat-mic.tsx",
      "src/components/chat-report.tsx",
      "src/components/chat/answer-controls.tsx",
      "src/components/chat/answer-turn.tsx",
      "src/components/chat/ask-card.tsx",
      "src/components/chat/browser-panel.tsx",
      "src/components/chat/composer-add-menu.tsx",
      "src/components/chat/connected-starters.tsx",
      "src/components/chat/date-divider.tsx",
      "src/components/chat/document-card.tsx",
      "src/components/chat/document-panel.tsx",
      "src/components/chat/document-progress.tsx",
      "src/components/chat/edit-turn.tsx",
      "src/components/chat/first-document.tsx",
      "src/components/chat/kickoff-card.tsx",
      "src/components/chat/live-answer.tsx",
      "src/components/chat/model-chip.tsx",
      "src/components/chat/out-of-credits.tsx",
      "src/components/chat/question-turn.tsx",
      "src/components/chat/sign-in-card.tsx",
      "src/components/chat/takeover-card.tsx",
      "src/components/chat/thinking-chip.tsx",
      "src/components/chat/thread-title.tsx",
      "src/components/chat/turn-actions.tsx",
      "src/components/delete-agent-dialog.tsx",
      "src/components/document-preview-dialog.tsx",
      "src/components/folder-readers-dialog.tsx",
      "src/components/generate-persona-button.tsx",
      "src/components/idea-board.tsx",
      "src/components/integrations/app-logo.tsx",
      "src/components/invite-member-dialog.tsx",
      "src/components/knowledge-explorer.tsx",
      "src/components/legal-layout.tsx",
      "src/components/live-key-warning.tsx",
      "src/components/markdown.tsx",
      "src/components/model-cost.tsx",
      "src/components/model-picker.tsx",
      "src/components/prompt-kit/prompt-input.tsx",
      "src/components/prompt-kit/reasoning.tsx",
      "src/components/prompt-kit/tool.tsx",
      "src/components/routines/email-address-setup.tsx",
      "src/components/routines/event-picker.tsx",
      "src/components/routines/github-webhook-setup.tsx",
      "src/components/routines/routine-browser-card.tsx",
      "src/components/routines/routine-detail.tsx",
      "src/components/routines/routine-editor.tsx",
      "src/components/routines/routine-event-card.tsx",
      "src/components/routines/routine-output-card.tsx",
      "src/components/routines/routine-page.tsx",
      "src/components/routines/routine-webhook-card.tsx",
      "src/components/routines/routines-pane.tsx",
      "src/components/routines/schedule-picker.tsx",
      "src/components/routines/telegram-bot-setup.tsx",
      "src/components/share-agent-dialog.tsx",
      "src/components/source-chip.tsx",
      "src/components/text-prompt-dialog.tsx",
      "src/components/tile.tsx",
      "src/components/workspace-activity-section.tsx",
      "src/lib/agents-store.tsx",
      "src/routes/_authed.agents.$agentId.chat.tsx",
      "src/routes/_authed.agents.$agentId.configuration.tsx",
      "src/routes/_authed.agents.$agentId.index.tsx",
      "src/routes/_authed.agents.$agentId.routines.$routineId.tsx",
      "src/routes/_authed.agents.$agentId.routines.index.tsx",
      "src/routes/_authed.agents.$agentId.settings.tsx",
      "src/routes/_authed.agents.$agentId.threads.tsx",
      "src/routes/_authed.agents.$agentId.tsx",
      "src/routes/_authed.documents.$documentId.print.tsx",
      "src/routes/_authed.knowledge.tsx",
      "src/routes/_authed.routines.$routineId.edit.tsx",
      "src/routes/_authed.routines.$routineId.index.tsx",
      "src/routes/_authed.routines.index.tsx",
      "src/routes/_authed.settings.api-keys.tsx",
      "src/routes/_authed.team.tsx",
      "src/routes/_authed.tsx",
    ],
    ignores: ["**/*.test.tsx"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        {
          // JSX text only: in attribute and expression position the rule
          // cannot tell a class name, a route or an enum from copy, and a
          // check that cries wolf on every `kind === "email"` is one people
          // learn to switch off. The catalogue test and migrated.static.test
          // cover the rest.
          mode: "jsx-text-only",
          "jsx-attributes": {
            include: [
              "aria-label",
              "placeholder",
              "title",
              "alt",
              "label",
              "description",
              "help",
              "hint",
              "empty",
            ],
          },
          "jsx-components": { exclude: ["Trans", "Kbd", "code"] },
          words: {
            // Punctuation and symbols are not words; product and vendor
            // names are not translated.
            exclude: [
              "[0-9!-/:-@[-`{-~]+",
              // A route path or a query key is an identifier, not copy.
              "^/.*",
              "[·—–…×✓✗→←]+",
              "Covan",
              "Slack",
              "Notion",
              "Google Drive",
              "Composio",
              "Telegram",
              "GitHub",
              "API",
              "OK",
            ],
          },
        },
      ],
    },
  },
  eslintPluginPrettier,
);
