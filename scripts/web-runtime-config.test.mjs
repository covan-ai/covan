// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  SENTINELS,
  resolveValues,
  substitute,
  assertNothingLeftOver,
} from "./web-runtime-config.mjs";

/*
 * Vite inlines VITE_* at build time, which is why there has never been a
 * publishable web image: the bundle carries whoever built it's Supabase project
 * as a literal string. The image is built against sentinel values instead and
 * swaps them for the real ones when the container starts, so one image serves
 * everybody.
 *
 * The failure this guards against is not "the substitution is wrong" — that
 * shows up immediately. It is "the substitution silently did not happen", which
 * produces a container that starts, serves pages, and cannot sign anyone in.
 */

const values = {
  VITE_SUPABASE_URL: "https://abc.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key",
  VITE_API_URL: "https://api.example.com",
  VITE_TERMS_URL: "",
  VITE_PRIVACY_URL: "",
};

describe("resolving the values to substitute", () => {
  it("takes each one from the environment", () => {
    const env = { ...values, VITE_SUPABASE_URL: "https://xyz.supabase.co" };
    expect(resolveValues(env).VITE_SUPABASE_URL).toBe("https://xyz.supabase.co");
  });

  it("names every missing required variable at once", () => {
    // One restart per missing variable is a bad way to find out you needed three.
    expect(() => resolveValues({ VITE_API_URL: "https://api.example.com" })).toThrow(
      /VITE_SUPABASE_URL.*VITE_SUPABASE_ANON_KEY|VITE_SUPABASE_ANON_KEY.*VITE_SUPABASE_URL/s,
    );
  });

  it("lets an optional variable go unset, which the app reads as its own default", () => {
    // src/lib/legal.ts treats "" and undefined identically, so an operator with
    // no terms of their own gets the built-in /terms page rather than a dead link.
    const resolved = resolveValues({
      VITE_SUPABASE_URL: "https://abc.supabase.co",
      VITE_SUPABASE_ANON_KEY: "anon-key",
      VITE_API_URL: "https://api.example.com",
    });
    expect(resolved.VITE_TERMS_URL).toBe("");
  });
});

describe("substituting into a built bundle", () => {
  it("replaces every sentinel with its value", () => {
    const built = `const u="${SENTINELS.VITE_SUPABASE_URL}",k="${SENTINELS.VITE_SUPABASE_ANON_KEY}";`;
    expect(substitute(built, values)).toBe(`const u="https://abc.supabase.co",k="anon-key";`);
  });

  it("replaces a sentinel that appears more than once", () => {
    const built = `${SENTINELS.VITE_API_URL}|${SENTINELS.VITE_API_URL}`;
    expect(substitute(built, values)).toBe("https://api.example.com|https://api.example.com");
  });

  it("treats the value as text, not as a replacement pattern", () => {
    // `$&` in a replacement string means "the matched text" to String.replace.
    // A URL carrying a query string can contain one, and the failure would be a
    // bundle holding a mangled endpoint rather than an error anyone sees.
    const built = `"${SENTINELS.VITE_API_URL}"`;
    const withDollar = { ...values, VITE_API_URL: "https://api.example.com/?a=$&b" };
    expect(substitute(built, withDollar)).toBe(`"https://api.example.com/?a=$&b"`);
  });

  it("leaves everything else alone", () => {
    expect(substitute("nothing to see here", values)).toBe("nothing to see here");
  });
});

describe("the check that runs after substituting", () => {
  it("accepts a bundle with no sentinels left", () => {
    expect(() =>
      assertNothingLeftOver('const u="https://abc.supabase.co";', "client.js"),
    ).not.toThrow();
  });

  it("rejects a bundle that still has one, and says which file", () => {
    // This is the whole point of the check: a sentinel that survives means the
    // build and this script have drifted apart, and the container would
    // otherwise start and serve a frontend pointed at a domain that does not
    // resolve.
    expect(() => assertNothingLeftOver(`x="${SENTINELS.VITE_API_URL}"`, "client.js")).toThrow(
      /client\.js/,
    );
  });
});
