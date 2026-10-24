import { describe, expect, it } from "vitest";
import { missingStackVars } from "./preflight";

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
