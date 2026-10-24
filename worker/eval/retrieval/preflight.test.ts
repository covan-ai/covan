import { describe, expect, it } from "vitest";
import { invalidRetrieval, missingStackVars } from "./preflight";

/**
 * The runner refuses to start without the stack and a key, before it has
 * created anybody or spent anything — a half-configured run would otherwise
 * fail at the first case, or worse, look like a search that found nothing.
 */
describe("missingStackVars", () => {
  const all = {
    SUPABASE_TEST_URL: "http://localhost:8000",
    SUPABASE_TEST_ANON_KEY: "anon",
    SUPABASE_TEST_SERVICE_ROLE_KEY: "service",
    OPENAI_API_KEY: "sk",
  };

  it("finds nothing missing when everything is set", () => {
    expect(missingStackVars(all)).toEqual([]);
  });

  it("names what is unset or empty, in a fixed order", () => {
    expect(
      missingStackVars({
        ...all,
        SUPABASE_TEST_URL: undefined,
        OPENAI_API_KEY: "",
        SUPABASE_TEST_ANON_KEY: undefined,
      }),
    ).toEqual(["SUPABASE_TEST_URL", "SUPABASE_TEST_ANON_KEY", "OPENAI_API_KEY"]);
  });
});

/**
 * A run is only valid while every case actually searched the seeded corpus.
 * A failed search, or one that could not see the corpus at all, scores as
 * "found nothing" if it is let through — a results file of zeros that looks
 * like a measurement.
 */
describe("invalidRetrieval", () => {
  const ok = { failed: false, docNames: ["a.md"] };

  it("lets a retrieval that saw the corpus through", () => {
    expect(invalidRetrieval(ok, "c1")).toBeNull();
  });

  it("refuses a failed search, pointing at the embedding key first", () => {
    const reason = invalidRetrieval({ ...ok, failed: true }, "c1");
    expect(reason).toContain("c1");
    expect(reason).toContain("embedding key");
  });

  it("refuses a search that could not see any document", () => {
    const reason = invalidRetrieval({ failed: false, docNames: [] }, "c2");
    expect(reason).toContain("c2");
    expect(reason).toContain("no documents");
  });
});
