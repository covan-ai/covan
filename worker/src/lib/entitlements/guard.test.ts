import { describe, it, expect, vi, afterEach } from "vitest";
import { guardCredits, recordCredits } from "./guard";
import type { Entitlements } from "./index";
import { callerWorkspaceId } from "../workspace";

vi.mock("../workspace", () => ({ callerWorkspaceId: vi.fn() }));

/** The things the guard touches on a Hono context, and nothing else. */
function ctx(entitlements: Partial<Entitlements>, store: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { user: { id: "u1" }, entitlements, db: {}, ...store };
  return {
    values,
    get: (key: string) => values[key],
    set: (k: string, v: unknown) => {
      values[k] = v;
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(callerWorkspaceId).mockReset();
});

describe("guardCredits", () => {
  it("charges the workspace it was given, and remembers it", async () => {
    const check = vi.fn().mockResolvedValue({ allowed: true });
    const c = ctx({ check });

    await expect(guardCredits(c, "w-session")).resolves.toBeNull();

    expect(check).toHaveBeenCalledWith("w-session");
    expect(c.values.workspaceId).toBe("w-session");
    expect(callerWorkspaceId).not.toHaveBeenCalled();
  });

  it("falls back to the caller's active workspace when the route has no row", async () => {
    vi.mocked(callerWorkspaceId).mockResolvedValue("w-active");
    const check = vi.fn().mockResolvedValue({ allowed: true });
    const c = ctx({ check });

    await guardCredits(c);

    expect(check).toHaveBeenCalledWith("w-active");
    expect(c.values.workspaceId).toBe("w-active");
  });

  // The three routes with no row of their own ask for the caller's workspace.
  // "Nobody" used to let the work through uncharged, with no ceiling but the
  // rate limit.
  it("refuses when there is no workspace to charge", async () => {
    vi.mocked(callerWorkspaceId).mockResolvedValue(null);
    const check = vi.fn().mockResolvedValue({ allowed: true });
    const c = ctx({ check });

    const res = await guardCredits(c);

    expect(res?.status).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect(c.values.workspaceId).toBeUndefined();
  });

  it("answers 402 with the balance when the workspace is out of credits", async () => {
    const c = ctx({ check: vi.fn().mockResolvedValue({ allowed: false, balance: -0.4 }) });

    const res = await guardCredits(c, "w1");

    expect(res?.status).toBe(402);
    await expect(res?.json()).resolves.toEqual({ error: "credits_exhausted", balance: -0.4 });
  });

  it("lets the request through — loudly — when the balance cannot be read", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = ctx({ check: vi.fn().mockRejectedValue(new Error("db down")) });

    await expect(guardCredits(c, "w1")).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe("recordCredits", () => {
  it("charges the guarded workspace, attributed to the caller", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const c = ctx({ record }, { workspaceId: "w1" });

    await recordCredits(c, [{ kind: "composio_search" }], { sessionId: "s1" });

    expect(record).toHaveBeenCalledWith("w1", [{ kind: "composio_search" }], {
      userId: "u1",
      sessionId: "s1",
    });
  });

  it("writes nothing for an operation that consumed nothing", async () => {
    const record = vi.fn();
    const c = ctx({ record }, { workspaceId: "w1" });

    await recordCredits(c, []);
    await recordCredits(c, null);

    expect(record).not.toHaveBeenCalled();
  });

  it("charges nobody, and says so, when the guard never ran", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const record = vi.fn();

    await recordCredits(ctx({ record }), { kind: "composio_search" });

    expect(record).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it("never throws when the ledger write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = ctx(
      { record: vi.fn().mockRejectedValue(new Error("db down")) },
      { workspaceId: "w1" },
    );

    await expect(recordCredits(c, { kind: "composio_search" })).resolves.toBeUndefined();
  });
});
