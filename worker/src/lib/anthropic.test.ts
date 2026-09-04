import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";
import { createAnthropic } from "./anthropic";

const ANTHROPIC = "https://api.anthropic.com";

describe("createAnthropic", () => {
  it("talks to Anthropic when no endpoint is configured", () => {
    const client = createAnthropic({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(client.baseURL).toBe(ANTHROPIC);
  });

  it("talks to the configured endpoint instead", () => {
    const client = createAnthropic({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: "http://gateway.internal:8080",
    });
    expect(client.baseURL).toBe("http://gateway.internal:8080");
  });

  it("treats an empty ANTHROPIC_BASE_URL as unset", () => {
    // A blank line in a .env file arrives as "", and "" as a baseURL resolves
    // against the Worker's own origin — every request would come back to us.
    const client = createAnthropic({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "" });
    expect(client.baseURL).toBe(ANTHROPIC);
  });

  it("carries the api key through", () => {
    const client = createAnthropic({ ANTHROPIC_API_KEY: "sk-ant-local" });
    expect(client.apiKey).toBe("sk-ant-local");
  });

  it("refuses to build a client with no key, naming the variable", () => {
    // Only reachable through a routing bug — `resolveModel` will not return a
    // Claude id without this key. A 401 from Anthropic reads like a bad key
    // rather than a missing one, and would send whoever hit it to the wrong
    // place entirely.
    expect(() => createAnthropic({})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

/**
 * The same walk `openai.test.ts` does, for the same reason: the factory only
 * decides where these requests go if everything goes through it. A later call
 * site with a bare `new Anthropic({ apiKey })` would silently ignore
 * ANTHROPIC_BASE_URL for that one feature, and nothing else in the suite would
 * notice.
 */
const SRC = join(import.meta.dirname, "..");

const EXEMPT = new Set(["lib/anthropic.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("the Anthropic client factory", () => {
  it("is the only way production code constructs a client", () => {
    const direct = sourceFiles(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("new Anthropic("))
      .map((f) => relative(SRC, f))
      .filter((f) => !EXEMPT.has(f));

    expect(direct).toEqual([]);
  });
});
