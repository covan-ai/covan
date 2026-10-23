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
