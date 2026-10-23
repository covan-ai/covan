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
  "components/account/avatar-picker.tsx",
  "components/account/email-card.tsx",
  "components/account/password-card.tsx",
  "components/account/profile-form.tsx",
  "components/account/sessions-list.tsx",
  "components/account/sign-in-methods.tsx",
  "components/account/two-factor-card.tsx",
  "components/agent-configuration-form.tsx",
  "components/agent-folders-dialog.tsx",
  "components/agent-knowledge.tsx",
  "components/agent-mark.tsx",
  "components/agent-steps.tsx",
  "components/agent-top-bar.tsx",
  "components/api-keys-section.tsx",
  "components/app-shell.tsx",
  "components/ask-bar.tsx",
  "components/auth-layout.tsx",
  "components/avatar.tsx",
  "components/banner-stack.tsx",
  "components/banner.tsx",
  "components/brand-mark.tsx",
  "components/browser-signins-section.tsx",
  "components/chat-attach.tsx",
  "components/chat-mic.tsx",
  "components/chat-report.tsx",
  "components/chat/answer-controls.tsx",
  "components/chat/answer-turn.tsx",
  "components/chat/ask-card.tsx",
  "components/chat/browser-panel.tsx",
  "components/chat/composer-add-menu.tsx",
  "components/chat/connected-starters.tsx",
  "components/chat/date-divider.tsx",
  "components/chat/document-card.tsx",
  "components/chat/document-panel.tsx",
  "components/chat/document-progress.tsx",
  "components/chat/edit-turn.tsx",
  "components/chat/first-document.tsx",
  "components/chat/kickoff-card.tsx",
  "components/chat/live-answer.tsx",
  "components/chat/model-chip.tsx",
  "components/chat/out-of-credits.tsx",
  "components/chat/question-turn.tsx",
  "components/chat/sign-in-card.tsx",
  "components/chat/takeover-card.tsx",
  "components/chat/thinking-chip.tsx",
  "components/chat/thread-title.tsx",
  "components/chat/turn-actions.tsx",
  "components/chat/use-conversation-browser.ts",
  "components/chat/use-document-jobs.ts",
  "components/close-account-section.tsx",
  "components/coach-mark.tsx",
  "components/code-input.tsx",
  "components/command-palette.tsx",
  "components/coverage-notice.tsx",
  "components/create-agent-dialog.tsx",
  "components/credit-ledger.tsx",
  "components/credits-wall.tsx",
  "components/data-table.tsx",
  "components/delete-agent-dialog.tsx",
  "components/document-preview-dialog.tsx",
  "components/empty-page.tsx",
  "components/error-page.tsx",
  "components/export-workspace-section.tsx",
  "components/feedback-dialog.tsx",
  "components/folder-readers-dialog.tsx",
  "components/generate-persona-button.tsx",
  "components/getting-started.tsx",
  "components/hbar-list.tsx",
  "components/idea-board.tsx",
  "components/inbox-row.tsx",
  "components/integrations/add-service-dialog.tsx",
  "components/integrations/app-catalogue.tsx",
  "components/integrations/app-detail-dialog.tsx",
  "components/integrations/app-logo.tsx",
  "components/integrations/composio-card.tsx",
  "components/integrations/connection-card.tsx",
  "components/integrations/connection-scope.tsx",
  "components/integrations/drive-folder-dialog.tsx",
  "components/integrations/slack-card.tsx",
  "components/integrations/tool-connection-card.tsx",
  "components/invite-member-dialog.tsx",
  "components/knowledge-explorer.tsx",
  "components/legal-layout.tsx",
  "components/live-key-warning.tsx",
  "components/markdown.tsx",
  "components/model-cost.tsx",
  "components/model-picker.tsx",
  "components/new-thread-button.tsx",
  "components/oauth-buttons.tsx",
  "components/open-browsers.tsx",
  "components/preferences-section.tsx",
  "components/primary-nav.ts",
  "components/prompt-kit/prompt-input.tsx",
  "components/prompt-kit/reasoning.tsx",
  "components/prompt-kit/tool.tsx",
  "components/quota-support-form.tsx",
  "components/recently-deleted-section.tsx",
  "components/revealed-secret.tsx",
  "components/routines/delivery-channels-card.tsx",
  "components/routines/email-address-setup.tsx",
  "components/routines/event-picker.tsx",
  "components/routines/github-webhook-setup.tsx",
  "components/routines/routine-browser-card.tsx",
  "components/routines/routine-detail.tsx",
  "components/routines/routine-editor.tsx",
  "components/routines/routine-event-card.tsx",
  "components/routines/routine-output-card.tsx",
  "components/routines/routine-page.tsx",
  "components/routines/routine-webhook-card.tsx",
  "components/routines/routines-pane.tsx",
  "components/routines/schedule-picker.tsx",
  "components/routines/telegram-bot-setup.tsx",
  "components/saved-logins.tsx",
  "components/settings/settings-pages.ts",
  "components/share-agent-dialog.tsx",
  "components/sidebar",
  "components/source-chip.tsx",
  "components/sub-nav.tsx",
  "components/text-prompt-dialog.tsx",
  "components/threads-table.tsx",
  "components/tile.tsx",
  "components/top-bar.tsx",
  "components/ui/dialog.tsx",
  "components/usage-section.tsx",
  "components/webhooks-section.tsx",
  "components/welcome/assistant-step.tsx",
  "components/welcome/first-docs-step.tsx",
  "components/welcome/invite-accept-step.tsx",
  "components/welcome/welcome-layout.tsx",
  "components/welcome/workspace-step.tsx",
  "components/workspace-activity-section.tsx",
  "components/workspace-coverage-section.tsx",
  "components/workspace-usage-section.tsx",
  "hooks/use-connections.ts",
  "hooks/use-go-keys.ts",
  "i18n",
  "lib/accept-invitation.ts",
  "lib/admins-to-ask.ts",
  "lib/agent-access.ts",
  "lib/agent-meta.ts",
  "lib/agents-store.tsx",
  "lib/api-client.ts",
  "lib/api-error.ts",
  "lib/avatar-resize.ts",
  "lib/chart-scale.ts",
  "lib/chat-kickoff.ts",
  "lib/chat-starters.ts",
  "lib/coach-marks.ts",
  "lib/connections-api.ts",
  "lib/credits.ts",
  "lib/cron-to-prose.ts",
  "lib/day-groups.ts",
  "lib/document-export.ts",
  "lib/dot-states.ts",
  "lib/file-size.ts",
  "lib/first-week.ts",
  "lib/home-sentence.ts",
  "lib/inbox.ts",
  "lib/invitation-notice.ts",
  "lib/invite-send.ts",
  "lib/invite-text.ts",
  "lib/knowledge-templates.ts",
  "lib/message-groups.ts",
  "lib/monogram.ts",
  "lib/onboarding-config.ts",
  "lib/password-strength.ts",
  "lib/relative-time.ts",
  "lib/roles.ts",
  "lib/routine-state.ts",
  "lib/routine-templates.ts",
  "lib/safe-url.ts",
  "lib/session-label.ts",
  "lib/stale-documents.ts",
  "lib/step-summary.ts",
  "lib/supabase/mfa.ts",
  "lib/toast.ts",
  "lib/uploads.ts",
  "lib/use-chat-uploads.ts",
  "lib/use-dictation.ts",
  "lib/use-report.ts",
  "routes/_authed.agents.$agentId.chat.tsx",
  "routes/_authed.agents.$agentId.configuration.tsx",
  "routes/_authed.agents.$agentId.index.tsx",
  "routes/_authed.agents.$agentId.routines.$routineId.tsx",
  "routes/_authed.agents.$agentId.routines.index.tsx",
  "routes/_authed.agents.$agentId.settings.tsx",
  "routes/_authed.agents.$agentId.threads.tsx",
  "routes/_authed.agents.$agentId.tsx",
  "routes/_authed.app.tsx",
  "routes/_authed.documents.$documentId.print.tsx",
  "routes/_authed.inbox.tsx",
  "routes/_authed.knowledge.tsx",
  "routes/_authed.routines.$routineId.edit.tsx",
  "routes/_authed.routines.$routineId.index.tsx",
  "routes/_authed.routines.index.tsx",
  "routes/_authed.settings.api-keys.tsx",
  "routes/_authed.settings.coverage.tsx",
  "routes/_authed.settings.export.tsx",
  "routes/_authed.settings.general.tsx",
  "routes/_authed.settings.integrations.tsx",
  "routes/_authed.settings.preferences.tsx",
  "routes/_authed.settings.profile.tsx",
  "routes/_authed.settings.security.tsx",
  "routes/_authed.settings.tsx",
  "routes/_authed.settings.usage.tsx",
  "routes/_authed.team.tsx",
  "routes/_authed.threads.tsx",
  "routes/_authed.tsx",
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
