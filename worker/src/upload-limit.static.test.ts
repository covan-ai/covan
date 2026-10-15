import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A ratchet on the one limit the database depends on.
 *
 * The upload route's ceiling used to be a frontend courtesy with a worker
 * check beside it that measured the file and nothing else — the
 * browser-extracted `text` field, which is what actually gets chunked and
 * embedded, was unbounded, and so was any body sent without `Content-Length`.
 * Each chunk row is ~7 KB for 850 characters of text, so an unmeasured field is
 * an unmeasured share of the database. Nothing else in the suite would notice
 * the limit going missing again: every route test sends a body well under it.
 */

const ROUTES = join(import.meta.dirname, "routes");
const read = (file: string) => readFileSync(join(ROUTES, file), "utf8");

describe("upload limits", () => {
  it("the document upload limits the whole body by the shared constant", () => {
    const source = read("bundles.ts");
    expect(source).toMatch(
      /bundles\.use\(\s*"\/bundles\/:id\/documents\/upload",\s*uploadLimit\(\s*MAX_DIRECT_UPLOAD_BYTES,[\s\S]{0,160}?MAX_EXTRACTED_TEXT_BYTES,?\s*\)/,
    );
  });

  it("the document upload declares no size of its own", () => {
    // Two numbers that must agree is how the frontend ended up as the only one
    // that meant anything. `MAX_UPLOAD_BYTES` lives in lib/extract.ts.
    expect(read("bundles.ts")).not.toMatch(/\d+\s*\*\s*1024\s*\*\s*1024/);
  });

  it("every route that reads a multipart body says how much it will read", () => {
    const files = readdirSync(ROUTES).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    const parsing = files.filter((f) => read(f).includes("parseBody("));
    // If this ever comes back empty the check below passes vacuously.
    expect(parsing).toContain("bundles.ts");

    const unbounded = parsing.filter((f) => {
      const source = read(f);
      return (
        !source.includes("bodyLimit(") &&
        !source.includes("uploadLimit(") &&
        !/content-length/i.test(source)
      );
    });
    expect(unbounded).toEqual([]);
  });
});
