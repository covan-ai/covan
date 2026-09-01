import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every form that carries a password or an email address posts.
 *
 * A `<form>` with no `method` is a GET, and React's `onSubmit` is only attached
 * once the page hydrates. Submit inside that window — a cold cache, a slow
 * connection, a fast typist — and the browser does the default: it puts what
 * was typed in the query string, where it lands in the address bar and in
 * history. On `/sign-in` that is the password.
 *
 * This was found by walking the deployed site rather than by reading it, which
 * is the reason for a test that reads. The four forms are fixed today; a fifth
 * one added a year from now inherits the same window, and nothing about writing
 * it would bring this to mind.
 *
 * The file list is derived rather than written down, so a new route is covered
 * the moment it exists. What is written down is the exemption list, which is
 * empty and should stay that way — a form asking for a credential has no reason
 * to prefer GET.
 */

const ROUTES = join(import.meta.dirname ?? "src/routes", ".");

/**
 * A field name here means the form around it carries something private.
 *
 * Matched on the field's `id`, not on `type="password"`. Both password fields
 * on `/reset-password` are `type={showPassword ? "text" : "password"}`, so a
 * pattern looking for the literal attribute skips the one route where every
 * field is a password — the exact shape most worth catching.
 */
const SENSITIVE = /id="(password|confirmPassword|email)"|name="(password|email)"/;

function routeFiles(): string[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .sort();
}

/** Every `<form …>` opening tag in a file, with its attributes. */
function formTags(source: string): string[] {
  return [...source.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
}

describe("credential forms", () => {
  const offenders: string[] = [];

  for (const file of routeFiles()) {
    const source = readFileSync(join(ROUTES, file), "utf8");
    if (!SENSITIVE.test(source)) continue;
    for (const tag of formTags(source)) {
      if (!/method="post"/.test(tag)) offenders.push(`${file}: ${tag}`);
    }
  }

  it("never let the browser fall back to GET", () => {
    expect(offenders).toEqual([]);
  });

  it("covers the forms this was written for", () => {
    // A guard that matches nothing passes forever. This is the assertion that
    // the file list and the field pattern still find real forms.
    const covered = routeFiles().filter((f) => {
      const source = readFileSync(join(ROUTES, f), "utf8");
      return SENSITIVE.test(source) && formTags(source).length > 0;
    });
    expect(covered).toEqual(
      expect.arrayContaining([
        "forgot-password.tsx",
        "reset-password.tsx",
        "sign-in.tsx",
        "sign-up.tsx",
      ]),
    );
  });
});
