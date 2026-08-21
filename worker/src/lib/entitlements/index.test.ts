import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoutineEnv } from "../../types";
import {
  embeddingCost,
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
  it("allows everything and reports no limit", async () => {
    await expect(unlimitedEntitlements.check("u1")).resolves.toEqual({ allowed: true });
    await expect(unlimitedEntitlements.record("u1", 5_000_000)).resolves.toBeUndefined();
    await expect(unlimitedEntitlements.snapshot("u1")).resolves.toEqual({
      used: 0,
      limit: null,
      resetsAt: null,
    });
  });
});

describe("embeddingCost", () => {
  // The counter is denominated in chat tokens because that is where the money
  // goes. Embeddings cost roughly a two-hundredth as much, so charging them at
  // par would let a single upload — a tenth of a cent — eat a third of a small
  // monthly allowance.
  it("charges an embedding at a hundredth of a chat token", () => {
    expect(embeddingCost(100_000)).toBe(1_000);
    expect(embeddingCost(50_000)).toBe(500);
  });

  it("never rounds a real cost down to nothing", () => {
    expect(embeddingCost(1)).toBe(1);
    expect(embeddingCost(150)).toBe(2);
  });

  it("charges nothing for nothing", () => {
    expect(embeddingCost(0)).toBe(0);
    expect(embeddingCost(-5)).toBe(0);
    expect(embeddingCost(Number.NaN)).toBe(0);
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

    const e = entitlementsFor(env({ QUOTA_MONTHLY_TOKENS: "1000" }));

    expect(e).toBe(fake);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ QUOTA_MONTHLY_TOKENS: "1000" }));
  });

  // The failure this guards against is silent: a hosted deploy that points at
  // the plain entry point still serves every request and simply stops counting.
  it("complains when a quota is configured but no implementation is registered", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    entitlementsFor(env({ QUOTA_MONTHLY_TOKENS: "1000" }));

    expect(err).toHaveBeenCalledWith(expect.stringContaining("NOT being metered"));
  });

  it("says nothing when there is no quota to enforce", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    entitlementsFor(env());

    expect(err).not.toHaveBeenCalled();
  });

  it("logs the misconfiguration once, not on every request", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    entitlementsFor(env({ QUOTA_MONTHLY_TOKENS: "1000" }));
    entitlementsFor(env({ QUOTA_MONTHLY_TOKENS: "1000" }));
    entitlementsFor(env({ QUOTA_MONTHLY_TOKENS: "1000" }));

    expect(err).toHaveBeenCalledTimes(1);
  });
});
