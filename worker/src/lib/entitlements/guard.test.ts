import { describe, it, expect, vi, afterEach } from "vitest";
import { guardQuota, recordQuota } from "./guard";
import type { Entitlements } from "./index";
import { keysForUser } from "../keys/resolve";

// Defaults to the house-keys shape so tests that never touch this mock (the
// pre-existing 402 case above all) still get an answer `guardQuota` can read
// `.source` off of, instead of the `undefined` a bare `vi.fn()` returns.
vi.mock("../keys/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../keys/resolve")>()),
  keysForUser: vi
    .fn()
    .mockResolvedValue({ openai: "house", anthropic: undefined, source: "house" }),
}));

/** The things the guard touches on a Hono context, and nothing else. */
function ctx(
  entitlements: Partial<Entitlements>,
  extra: {
    db?: unknown;
    env?: unknown;
    providerEnv?: unknown;
    set?: (k: string, v: unknown) => void;
  } = {},
) {
  const store: Record<string, unknown> = {
    user: { id: "u1" },
    entitlements,
    db: extra.db ?? {},
    // Undefined unless a test says otherwise — the normal case, and the one
    // the old helper got wrong by answering every key with `entitlements`.
    providerEnv: extra.providerEnv,
  };
  return {
    env: extra.env ?? { OPENAI_API_KEY: "house" },
    get: (key: string) => store[key],
    set:
      extra.set ??
      ((k: string, v: unknown) => {
        store[k] = v;
      }),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks only touches spies made with vi.spyOn — a vi.fn() from a
  // vi.mock() factory, like keysForUser above, is "silently ignored" by it.
  // Without this, call counts from one test's mockResolvedValue leak into the
  // next test's "was this even called" assertions.
  //
  // mockClear() alone is not enough either: it wipes call history but leaves
  // whatever mockResolvedValue the previous test installed in place as the new
  // de-facto default, so a later test that forgets to reconfigure it silently
  // inherits "workspace" instead of the documented "house". mockReset() drops
  // that installed implementation too, so re-asserting the factory default
  // below is what actually makes every test start from the same place.
  vi.mocked(keysForUser).mockReset().mockResolvedValue({
    openai: "house",
    anthropic: undefined,
    source: "house",
  });
});

describe("guardQuota", () => {
  it("lets an allowed caller through", async () => {
    const denied = await guardQuota(ctx({ check: async () => ({ allowed: true }) }));
    expect(denied).toBeNull();
  });

  it("answers 402 with what the client needs to explain itself", async () => {
    const denied = await guardQuota(
      ctx({
        check: async () => ({
          allowed: false,
          used: 1200,
          limit: 1000,
          resetsAt: "2026-09-01T00:00:00.000Z",
        }),
      }),
    );

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(402);
    await expect(denied!.json()).resolves.toEqual({
      error: "quota_exceeded",
      used: 1200,
      limit: 1000,
      resetsAt: "2026-09-01T00:00:00.000Z",
    });
  });

  // Deliberate: the counter lives in the same database as everything else, so a
  // read failure means the app is already in trouble. Refusing every reply on
  // top of that turns a billing inconvenience into an outage.
  it("lets the request through — loudly — when the quota cannot be read", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const denied = await guardQuota(
      ctx({
        check: async () => {
          throw new Error("database unreachable");
        },
      }),
    );

    expect(denied).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe("recordQuota", () => {
  it("charges whole tokens to the caller", async () => {
    const record = vi.fn(async () => {});
    await recordQuota(ctx({ record }), 812.4);
    expect(record).toHaveBeenCalledWith("u1", 812);
  });

  it("writes nothing for a free operation", async () => {
    const record = vi.fn(async () => {});
    await recordQuota(ctx({ record }), 0);
    await recordQuota(ctx({ record }), Number.NaN);
    expect(record).not.toHaveBeenCalled();
  });

  // The work is already done and the reply already sent. A counter that cannot
  // be written must not turn a successful operation into a failed one.
  it("never throws when the counter write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordQuota(
        ctx({
          record: async () => {
            throw new Error("write failed");
          },
        }),
        100,
      ),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});

const DENIED = {
  allowed: false as const,
  used: 100_000,
  limit: 100_000,
  resetsAt: "2026-10-01T00:00:00.000Z",
};

describe("guardQuota with a workspace key", () => {
  it("lets the request through and stashes the workspace env", async () => {
    vi.mocked(keysForUser).mockResolvedValue({
      openai: "ws-openai",
      anthropic: undefined,
      source: "workspace",
    });

    const set = vi.fn();
    const c = ctx({ check: async () => DENIED }, { set, env: { OPENAI_API_KEY: "house" } });

    expect(await guardQuota(c)).toBeNull();
    expect(set).toHaveBeenCalledWith(
      "providerEnv",
      expect.objectContaining({ OPENAI_API_KEY: "ws-openai" }),
    );
  });

  it("still answers 402 when the workspace has no key", async () => {
    vi.mocked(keysForUser).mockResolvedValue({
      openai: "house",
      anthropic: undefined,
      source: "house",
    });

    const set = vi.fn();
    const c = ctx({ check: async () => DENIED }, { set, env: { OPENAI_API_KEY: "house" } });

    const denied = await guardQuota(c);
    expect(denied?.status).toBe(402);
    expect(set).not.toHaveBeenCalledWith("providerEnv", expect.anything());
  });

  it("does not look for a key at all while the caller is within allowance", async () => {
    const c = ctx({ check: async () => ({ allowed: true }) }, { set: vi.fn(), env: {} });
    expect(await guardQuota(c)).toBeNull();
    expect(keysForUser).not.toHaveBeenCalled();
  });
});

describe("recordQuota under a workspace key", () => {
  it("counts nothing when the workspace is paying", async () => {
    const record = vi.fn();
    const c = ctx(
      { check: async () => DENIED, record },
      { set: vi.fn(), env: {}, providerEnv: { OPENAI_API_KEY: "ws-openai" } },
    );

    await recordQuota(c, 5_000);
    expect(record).not.toHaveBeenCalled();
  });

  it("still counts when the operator is paying", async () => {
    const record = vi.fn();
    const c = ctx({ check: async () => ({ allowed: true }), record }, { set: vi.fn(), env: {} });

    await recordQuota(c, 5_000);
    expect(record).toHaveBeenCalledWith(expect.any(String), 5_000);
  });
});
