import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { privacyLink, termsLink } from "@/lib/legal";

// TanStack Router's flat file routing makes `a.tsx` the PARENT of `a.b.tsx`.
// A parent renders its child through <Outlet />, so a parent without one
// silently swallows every child route: the URL matches, the child component
// never mounts, and the user just keeps looking at the parent. Nothing in the
// type system or the generated tree catches it, and a component test does not
// either, because the components themselves are fine.
//
// This is the invariant that would have caught /agents/$agentId/routines
// swallowing /agents/$agentId/routines/$routineId.

// Resolved from the project root rather than import.meta.url: under jsdom the
// module URL is not a file: URL.
const ROUTES_DIR = `${process.cwd()}/src/routes/`;

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));
}

describe("route files", () => {
  it("every route with children renders an <Outlet />", () => {
    const names = routeFiles().map((f) => f.replace(/\.tsx$/, ""));

    const parentsMissingOutlet = names
      .filter((name) => names.some((other) => other.startsWith(`${name}.`)))
      .filter((name) => !readFileSync(`${ROUTES_DIR}${name}.tsx`, "utf8").includes("<Outlet"));

    expect(parentsMissingOutlet).toEqual([]);
  });

  // src/lib/legal.ts falls back to a built-in page whenever VITE_TERMS_URL or
  // VITE_PRIVACY_URL is unset, which is every deployment that has not gone out
  // of its way to set one — so the fallback is the common case here, not the
  // edge one. A fallback naming a route that does not exist is a 404 reached
  // from a required "I agree" checkbox, and nothing else would catch it: the
  // link is resolved by one module and the page is owned by another, so
  // neither side is wrong on its own.
  it("has a page behind every legal link that falls back to a built-in one", () => {
    const builtIn = [termsLink(), privacyLink()]
      .filter((link) => !link.external)
      .map((link) => `${link.href.replace(/^\//, "")}.tsx`);

    expect(builtIn).not.toEqual([]);
    expect(routeFiles()).toEqual(expect.arrayContaining(builtIn));
  });

  // Having the pages is not the same as being able to reach them. This build
  // has no landing page, so for the whole beta the only link to either document
  // anywhere was the sign-up form's "I agree" checkbox — the one surface a
  // person passes through exactly once. This walks the source rather than
  // rendering Settings, because the regression to catch is a deletion, and a
  // deleted link fails no render test.
  it("links to both documents from somewhere inside the signed-in app", () => {
    const authed = routeFiles()
      .filter((f) => f.startsWith("_authed"))
      .map((f) => readFileSync(`${ROUTES_DIR}${f}`, "utf8"));

    expect(authed.some((src) => src.includes("termsLink"))).toBe(true);
    expect(authed.some((src) => src.includes("privacyLink"))).toBe(true);
  });
});
