import { describe, it, expect, vi, afterEach } from "vitest";
import { guardQuota, recordQuota } from "./guard";
import type { Entitlements } from "./index";

/** The two things the guard touches on a Hono context, and nothing else. */
function ctx(entitlements: Partial<Entitlements>) {
  return {
    get: (key: string) => (key === "user" ? { id: "u1" } : (entitlements as Entitlements)),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  } as any;
}

afterEach(() => vi.restoreAllMocks());

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
