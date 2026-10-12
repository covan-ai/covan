import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoutineEnv } from "../../types";
import {
  completionSpend,
  embeddingSpend,
  spends,
  entitlementsFor,
  resetEntitlements,
  unlimitedEntitlements,
  registerEntitlements,
  type Entitlements,
} from "./index";

const env = (over: Partial<RoutineEnv> = {}): RoutineEnv =>
  ({
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    OPENAI_API_KEY: "sk-test",
    ROUTINE_SECRET_KEY: "k",
    RESEND_API_KEY: "re",
    RESEND_FROM: "R <r@e.com>",
    ALLOWED_ORIGIN: "http://localhost:3000",
    ...over,
  }) as RoutineEnv;

afterEach(() => {
  resetEntitlements();
  vi.restoreAllMocks();
});

describe("unlimitedEntitlements", () => {
  // The open build's default has to be a working implementation, not a stub
  // that throws or a licence check. A self-hoster gets the whole product.
  it("allows everything and reports that nothing is metered", async () => {
    await expect(unlimitedEntitlements.check("w1")).resolves.toEqual({ allowed: true });
    await expect(
      unlimitedEntitlements.record("w1", [{ kind: "composio_search" }], {}),
    ).resolves.toBeUndefined();
    await expect(unlimitedEntitlements.snapshot("w1")).resolves.toEqual({ metered: false });
  });
});

describe("completionSpend", () => {
  it("reports the counts the provider gave, and the purpose", () => {
    expect(
      completionSpend(
        "claude-sonnet-5",
        {
          promptTokens: 1_000,
          completionTokens: 200,
          cachedTokens: 800,
          cacheWriteTokens: null,
          reasoningTokens: null,
          webSearches: 2,
        },
        "reply",
      ),
    ).toEqual({
      kind: "completion",
      model: "claude-sonnet-5",
      promptTokens: 1_000,
      completionTokens: 200,
      cachedTokens: 800,
      webSearches: 2,
      purpose: "reply",
    });
  });

  it("is null for a call that reported nothing, which cost nothing", () => {
    expect(completionSpend("gpt-4.1", null)).toBeNull();
    expect(completionSpend("gpt-4.1", { promptTokens: null, completionTokens: null })).toBeNull();
    expect(completionSpend("gpt-4.1", { promptTokens: 0, completionTokens: 0 })).toBeNull();
  });

  it("never reports a negative or fractional count", () => {
    expect(completionSpend("gpt-4.1", { promptTokens: -5, completionTokens: 2.6 })).toEqual({
      kind: "completion",
      model: "gpt-4.1",
      promptTokens: 0,
      completionTokens: 3,
    });
  });
});

describe("embeddingSpend", () => {
  it("reports tokens, model and purpose", () => {
    expect(embeddingSpend("text-embedding-3-small", 120, "index")).toEqual({
      kind: "embedding",
      model: "text-embedding-3-small",
      tokens: 120,
      purpose: "index",
    });
  });

  it("is null for nothing embedded", () => {
    expect(embeddingSpend("m", 0)).toBeNull();
    expect(embeddingSpend("m", Number.NaN)).toBeNull();
    expect(embeddingSpend("m", undefined)).toBeNull();
  });
});

describe("spends", () => {
  it("drops the empties so a call site stays one line", () => {
    expect(spends(null, { kind: "composio_search" }, undefined, false)).toEqual([
      { kind: "composio_search" },
    ]);
  });
});

describe("entitlementsFor", () => {
  it("hands back the unmetered implementation when nothing is registered", () => {
    expect(entitlementsFor(env())).toBe(unlimitedEntitlements);
  });

  it("hands back a registered implementation, built from the environment", () => {
    const fake = { check: vi.fn(), record: vi.fn(), snapshot: vi.fn() } as unknown as Entitlements;
    const factory = vi.fn(() => fake);
    registerEntitlements(factory);

    const e = entitlementsFor(env({ CREDITS_ENABLED: "1" }));

    expect(e).toBe(fake);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ CREDITS_ENABLED: "1" }));
  });

  // The failure this guards against is silent: a hosted deploy that points at
  // the plain entry point still serves every request and simply stops charging.
  it("complains when credits are enabled but no implementation is registered", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    entitlementsFor(env({ CREDITS_ENABLED: "1" }));

    expect(err).toHaveBeenCalledWith(expect.stringContaining("NOT being charged"));
  });

  it("says nothing when there is nothing to charge", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    entitlementsFor(env());

    expect(err).not.toHaveBeenCalled();
  });

  it("logs the misconfiguration once, not on every request", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    entitlementsFor(env({ CREDITS_ENABLED: "1" }));
    entitlementsFor(env({ CREDITS_ENABLED: "1" }));
    entitlementsFor(env({ CREDITS_ENABLED: "1" }));

    expect(err).toHaveBeenCalledTimes(1);
  });
});
