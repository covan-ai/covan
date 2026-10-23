import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A file that has been translated stays translated.
 *
 * The interface is moving to `t()` one area at a time, and in the meantime
 * both kinds of file live side by side: those that still say their English
 * inline, and those that have been through the recipe. The ESLint rule
 * (`i18next/no-literal-string`, scoped to the same list in eslint.config.js)
 * sees JSX; this sees what it does not — a toast raised with a bare string,
 * a `=== 1 ? "file" : "files"` that cannot be translated, a date formatted
 * for one country, a `toUpperCase()` that turns a Turkish i into the wrong
 * letter.
 *
 * `MIGRATED` grows with every phase, by directory where a whole one is
 * done. When it names all of `src/components` and `src/routes` the list,
 * and this comment, can go.
 */

const SRC = join(import.meta.dirname, "..");

/** Files and directories, relative to src/, that have been through the recipe. */
export const MIGRATED: string[] = [
  "i18n",
  "lib/toast.ts",
  "lib/api-error.ts",
  "lib/session-label.ts",
  "components/primary-nav.ts",
  "components/sidebar",
  "components/app-shell.tsx",
  "components/top-bar.tsx",
  "components/banner.tsx",
  "components/banner-stack.tsx",
  "components/error-page.tsx",
  "components/empty-page.tsx",
  "components/command-palette.tsx",
  "components/feedback-dialog.tsx",
  "components/new-thread-button.tsx",
  "components/ui/dialog.tsx",
  "components/settings/settings-pages.ts",
  "lib/accept-invitation.ts",
  "lib/day-groups.ts",
  "lib/relative-time.ts",
  "lib/roles.ts",
  "lib/chart-scale.ts",
  "lib/credits.ts",
  "lib/home-sentence.ts",
  "lib/inbox.ts",
  "lib/first-week.ts",
  "lib/invitation-notice.ts",
  "lib/invite-text.ts",
  "components/account/avatar-picker.tsx",
  "components/account/email-card.tsx",
  "components/account/password-card.tsx",
  "components/account/profile-form.tsx",
  "components/account/sessions-list.tsx",
  "components/account/sign-in-methods.tsx",
  "components/account/two-factor-card.tsx",
  "components/api-keys-section.tsx",
  "components/auth-layout.tsx",
  "components/browser-signins-section.tsx",
  "components/close-account-section.tsx",
  "components/coach-mark.tsx",
  "components/code-input.tsx",
  "components/coverage-notice.tsx",
  "components/create-agent-dialog.tsx",
  "components/credit-ledger.tsx",
  "components/credits-wall.tsx",
  "components/data-table.tsx",
  "components/export-workspace-section.tsx",
  "components/getting-started.tsx",
  "components/hbar-list.tsx",
  "components/inbox-row.tsx",
  "components/integrations/add-service-dialog.tsx",
  "components/integrations/app-catalogue.tsx",
  "components/integrations/app-detail-dialog.tsx",
  "components/integrations/composio-card.tsx",
  "components/integrations/connection-card.tsx",
  "components/integrations/connection-scope.tsx",
  "components/integrations/drive-folder-dialog.tsx",
  "components/integrations/slack-card.tsx",
  "components/integrations/tool-connection-card.tsx",
  "components/oauth-buttons.tsx",
  "components/open-browsers.tsx",
  "components/preferences-section.tsx",
  "components/quota-support-form.tsx",
  "components/recently-deleted-section.tsx",
  "components/revealed-secret.tsx",
  "components/routines/delivery-channels-card.tsx",
  "components/saved-logins.tsx",
  "components/sub-nav.tsx",
  "components/threads-table.tsx",
  "components/usage-section.tsx",
  "components/webhooks-section.tsx",
  "components/welcome/assistant-step.tsx",
  "components/welcome/first-docs-step.tsx",
  "components/welcome/invite-accept-step.tsx",
  "components/welcome/welcome-layout.tsx",
  "components/welcome/workspace-step.tsx",
  "components/workspace-coverage-section.tsx",
  "components/workspace-usage-section.tsx",
  "lib/connections-api.ts",
  "lib/dot-states.ts",
  "lib/onboarding-config.ts",
  "lib/password-strength.ts",
  "lib/routine-state.ts",
  "lib/stale-documents.ts",
  "routes/_authed.app.tsx",
  "routes/_authed.inbox.tsx",
  "routes/_authed.settings.coverage.tsx",
  "routes/_authed.settings.export.tsx",
  "routes/_authed.settings.general.tsx",
  "routes/_authed.settings.integrations.tsx",
  "routes/_authed.settings.preferences.tsx",
  "routes/_authed.settings.profile.tsx",
  "routes/_authed.settings.security.tsx",
  "routes/_authed.settings.tsx",
  "routes/_authed.settings.usage.tsx",
  "routes/_authed.threads.tsx",
  "routes/_authed.welcome.tsx",
  "routes/auth.callback.tsx",
  "routes/confirm-address.tsx",
  "routes/confirmed.tsx",
  "routes/forgot-password.tsx",
  "routes/index.tsx",
  "routes/invite.tsx",
  "routes/reset-password.tsx",
  "routes/sign-in.tsx",
  "routes/sign-up.tsx",
  "routes/two-factor.tsx",
];

const LEFTOVERS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "a toast with inline words",
    pattern: /toast\.(success|error|warning|info|message)\(\s*["'`]/,
  },
  { name: "a plural the translation cannot follow", pattern: /===\s*1\s*\?\s*["'`]/ },
  {
    name: "a date or number formatted for one country",
    pattern: /\b(toLocale\w+|Intl\.\w+|localeCompare)\(\s*["'](en-US|en-GB|en)["']/,
  },
  { name: "case changed without a locale", pattern: /\.to(Upper|Lower)Case\(\)/ },
];

/**
 * `toUpperCase()` on something that is not a word in any language — a
 * hex digest, a file extension, an HTTP method — is fine, and this is how
 * a line says so: on the line itself, or in the comment just above it,
 * since the formatter moves a trailing comment of its own accord. Spell it
 * out rather than disabling the check for a file.
 */
const EXEMPT = /\bi18n-ignore\b/;

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("translated files", () => {
  it("keep nothing the translation cannot reach", () => {
    const offenders = MIGRATED.flatMap((entry) =>
      sourceFiles(join(SRC, entry)).flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line, i, lines) => {
            if (EXEMPT.test(line) || EXEMPT.test(lines[i - 1] ?? "")) return [];
            const hit = LEFTOVERS.find(({ pattern }) => pattern.test(line));
            return hit
              ? [`${path.slice(SRC.length + 1)}:${i + 1} (${hit.name}): ${line.trim()}`]
              : [];
          }),
      ),
    );

    expect(offenders).toEqual([]);
  });
});
