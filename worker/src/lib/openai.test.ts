import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOpenAI, createEmbeddingClient } from "./openai";

const OPENAI = "https://api.openai.com/v1";

beforeEach(() => {
  // The SDK falls back to process.env.OPENAI_BASE_URL on its own, which would
  // make "unset" mean something different on a developer's machine than in CI.
  vi.stubEnv("OPENAI_BASE_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("createOpenAI", () => {
  it("talks to OpenAI when no endpoint is configured", () => {
    const client = createOpenAI({ OPENAI_API_KEY: "sk-test" });
    expect(client.baseURL).toBe(OPENAI);
  });

  it("talks to the configured endpoint instead", () => {
    const client = createOpenAI({
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "http://localhost:11434/v1",
    });
    expect(client.baseURL).toBe("http://localhost:11434/v1");
  });

  it("treats an empty OPENAI_BASE_URL as unset", () => {
    const client = createOpenAI({ OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "" });
    expect(client.baseURL).toBe(OPENAI);
  });

  it("carries the api key through to the configured endpoint", () => {
    const client = createOpenAI({
      OPENAI_API_KEY: "sk-local",
      OPENAI_BASE_URL: "http://vllm:8000/v1",
    });
    expect(client.apiKey).toBe("sk-local");
  });
});

describe("createEmbeddingClient", () => {
  it("talks to OpenAI when no embedding endpoint is configured", () => {
    const client = createEmbeddingClient({ OPENAI_API_KEY: "sk-test" });
    expect(client.baseURL).toBe(OPENAI);
  });

  it("talks to the configured endpoint instead", () => {
    const client = createEmbeddingClient({
      OPENAI_API_KEY: "sk-test",
      EMBEDDING_BASE_URL: "http://localhost:11434/v1",
    });
    expect(client.baseURL).toBe("http://localhost:11434/v1");
  });

  it("treats an empty EMBEDDING_BASE_URL as unset", () => {
    const client = createEmbeddingClient({ OPENAI_API_KEY: "sk-test", EMBEDDING_BASE_URL: "" });
    expect(client.baseURL).toBe(OPENAI);
  });

  /**
   * The one that is easy to get wrong and impossible to notice.
   *
   * Moving completions is not the same decision as moving every document you
   * own, so the two variables do not inherit from each other. Two ways that
   * could silently stop being true: reading OPENAI_BASE_URL as a fallback, or
   * passing no baseURL at all and letting the SDK read process.env for it —
   * which would make the Docker stack disagree with Cloudflare, since compose
   * puts OPENAI_BASE_URL in the environment and Workers has no process.env.
   */
  it("does not inherit the completions endpoint, from the argument or the environment", () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:11434/v1");

    const client = createEmbeddingClient({
      OPENAI_API_KEY: "sk-test",
      // @ts-expect-error deliberately passing the wrong variable, the way an
      // operator's environment does when only OPENAI_BASE_URL is set.
      OPENAI_BASE_URL: "http://localhost:11434/v1",
    });

    expect(client.baseURL).toBe(OPENAI);
  });
});

/**
 * The factory only closes the hole if everything goes through it. A sixth
 * completion call site added later with a bare `new OpenAI({ apiKey })` would
 * silently reopen it for that one feature, and nothing else in the suite would
 * notice — so this walks the source instead of trusting a review to catch it.
 */
const SRC = join(import.meta.dirname, "..");

/**
 * Routed to OpenAI on purpose, and down to one: `lib/transcribe.ts`, because
 * `/audio/transcriptions` is missing from most OpenAI-compatible servers.
 * `lib/embeddings.ts` was here until embeddings got a seam of their own.
 */
const EXEMPT = new Set(["lib/transcribe.ts", "lib/openai.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("the OpenAI client factory", () => {
  it("is the only way production code constructs a client, apart from transcription", () => {
    const direct = sourceFiles(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("new OpenAI("))
      .map((f) => relative(SRC, f))
      .filter((f) => !EXEMPT.has(f));

    expect(direct).toEqual([]);
  });
});
