// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  SENTINELS,
  resolveValues,
  substitute,
  assertNothingLeftOver,
  assetEtag,
  updateAssetManifest,
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

/*
 * The bug that made the whole idea not work, and which every check anyone would
 * think to run missed. Nitro bakes a manifest of every public asset — including
 * its size — into the server bundle and serves Content-Length from it.
 * Substituting a 38-character sentinel for a 21-character URL leaves the file
 * shorter than the manifest promises, the browser aborts the response with
 * ERR_CONTENT_LENGTH_MISMATCH, and React never hydrates. The page renders. The
 * health check passes. Every button does nothing.
 */

/**
 * Shaped like the real thing. Nitro writes this as JavaScript source, and the
 * etag *value* itself contains quotes — `"etag": "\"9c3-hash\""` — so the
 * fixture builds it the same way the code does rather than by hand-escaping,
 * which is how the first version of this test managed to be wrong.
 */
const manifest = (size, etag) => `
const assets = {
  "/assets/index-AbC123.js": {
    "type": "text/javascript; charset=utf-8",
    "etag": ${JSON.stringify('"9c3-otherhashotherhashotherh"')},
    "mtime": "2026-08-26T09:01:08.854Z",
    "size": 2499,
    "path": "../public/assets/index-AbC123.js"
  },
  "/assets/api-client-XyZ.js": {
    "type": "text/javascript; charset=utf-8",
    "etag": ${JSON.stringify(etag)},
    "mtime": "2026-08-26T09:01:08.854Z",
    "size": ${size},
    "path": "../public/assets/api-client-XyZ.js"
  }
};
`;

describe("the recorded size of a substituted asset", () => {
  const bytes = Buffer.from("const API='https://api.example.com';", "utf8");

  it("is corrected to what the file now weighs", () => {
    const out = updateAssetManifest(manifest(9999, '"270f-stalehashstalehashstaleh"'), [
      ["/assets/api-client-XyZ.js", bytes],
    ]);
    expect(out).toContain(`"size": ${bytes.length}`);
    expect(out).not.toContain('"size": 9999');
  });

  it("gets a matching etag, not merely a valid one", () => {
    // A stale etag serves a 304 for content that changed, which is the same
    // class of failure arriving a day later through a cache.
    const out = updateAssetManifest(manifest(9999, '"270f-stalehashstalehashstaleh"'), [
      ["/assets/api-client-XyZ.js", bytes],
    ]);
    // The manifest holds the etag as a JS string whose value carries quotes, so
    // compare against the same encoding the file actually contains.
    expect(out).toContain(JSON.stringify(assetEtag(bytes)));
    expect(out).not.toContain("stalehashstalehashstaleh");
  });

  it("leaves every other entry alone", () => {
    const out = updateAssetManifest(manifest(9999, '"270f-stalehashstalehashstaleh"'), [
      ["/assets/api-client-XyZ.js", bytes],
    ]);
    expect(out).toContain('"size": 2499');
    expect(out).toContain("otherhashotherhashotherh");
  });

  it("accepts a manifest that is already correct", () => {
    // The restart case, and it is the ordinary one. The container runs this
    // script on every start, substituting from the pristine .covan-tmpl copies,
    // so a restart with UNCHANGED environment variables produces byte-identical
    // assets — and therefore the size and etag the manifest already holds.
    //
    // Treating "the replacement changed nothing" as "the entry has no size or
    // etag" made that indistinguishable from a manifest this script cannot
    // read, so the second start of any web container threw and the third and
    // every one after it did too. Measured against a running covan-web: four
    // .covan-tmpl copies present, the asset already substituted, and the
    // container in a restart loop with "Its shape is not what this script
    // expects".
    const already = updateAssetManifest(manifest(9999, '"270f-stalehashstalehashstaleh"'), [
      ["/assets/api-client-XyZ.js", bytes],
    ]);
    expect(() =>
      updateAssetManifest(already, [["/assets/api-client-XyZ.js", bytes]]),
    ).not.toThrow();
    expect(updateAssetManifest(already, [["/assets/api-client-XyZ.js", bytes]])).toBe(already);
  });

  it("refuses an entry missing only its size, which used to pass", () => {
    // The dangerous half. Under the old check this threw nothing, because
    // rewriting the etag alone counted as "something changed" — so the size
    // stayed stale and the browser got a Content-Length it could not satisfy,
    // which is the exact failure this function exists to prevent. It has to
    // fail here instead, and it has to say which field.
    const noSize = manifest(9999, '"270f-stalehashstalehashstaleh"').replace('"size": 9999,', "");
    expect(() => updateAssetManifest(noSize, [["/assets/api-client-XyZ.js", bytes]])).toThrow(
      /no size to correct/,
    );
  });

  it("refuses to start when an asset has no entry, rather than shipping the bug again", () => {
    // If a future nitro keeps this manifest somewhere else, that has to fail
    // here — loudly — instead of producing another image that looks fine until
    // somebody clicks something.
    expect(() =>
      updateAssetManifest(manifest(9999, '"270f-x"'), [["/assets/not-there.js", bytes]]),
    ).toThrow(/no manifest entry/);
  });

  it("refuses when the entry has neither field to correct", () => {
    const shapeless = `const assets = { "/assets/api-client-XyZ.js": { "type": "text/javascript" } };`;
    expect(() => updateAssetManifest(shapeless, [["/assets/api-client-XyZ.js", bytes]])).toThrow(
      /no size and no etag/,
    );
  });
});

describe("assetEtag", () => {
  it("reproduces the format nitro records", () => {
    // "<length in hex>-<27 chars of base64 sha1>", verified against an
    // untouched entry in a real build.
    const etag = assetEtag(Buffer.alloc(646, 0x61));
    expect(etag).toMatch(/^"286-[A-Za-z0-9+/]{27}"$/);
  });
});
