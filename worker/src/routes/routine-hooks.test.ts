import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { resetRateLimiters } from "../lib/ratelimit";

const resolveIngestToken = vi.fn();
const touchTrigger = vi.fn(async () => {});
const runPokedRoutine = vi.fn(async () => ({ status: "ok" as const, itemsNew: 1 }));

vi.mock("../lib/routines/ingest", () => ({ resolveIngestToken, touchTrigger }));
vi.mock("../lib/routines/dispatcher", () => ({ runPokedRoutine }));

const { routineHooks } = await import("./routine-hooks");

const ROUTINE = { id: "r1", user_id: "u1", name: "Deploys" };
const ENV = { RATE_LIMIT_EXPENSIVE_PER_MINUTE: "20" };

function post(
  path: string,
  init: { body?: string | ReadableStream; headers?: Record<string, string> } = {},
  env: Record<string, string> = {},
) {
  const app = new Hono<AppEnv>();
  app.route("/", routineHooks);
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: init.body ?? "{}",
      // A streamed body needs this in undici, and the route reads a stream.
      ...(typeof init.body === "object" ? { duplex: "half" } : {}),
    } as RequestInit,
    { ...ENV, ...env } as never,
  );
}

/** Let the `deferred()` work settle — it is not awaited by the response. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resolveIngestToken.mockReset().mockResolvedValue({ ok: true, routine: ROUTINE });
  // Reset, not clear: one test below leaves a deliberately unresolved
  // implementation behind, and `mockClear` keeps implementations. Carried into
  // the next test it hangs the deferred work rather than failing it, which
  // reads as "touchTrigger was never called" three tests later.
  runPokedRoutine.mockReset().mockResolvedValue({ status: "ok", itemsNew: 1 });
  touchTrigger.mockReset().mockResolvedValue(undefined);
  resetRateLimiters();
});

describe("POST /routine-hooks/:token", () => {
  it("answers 202 without waiting for the run", async () => {
    // The run is slow on purpose: a webhook sender times out long before a
    // model call finishes, and a timeout is followed by a retry.
    let finish!: () => void;
    runPokedRoutine.mockImplementation(
      () => new Promise((r) => (finish = () => r({ status: "ok", itemsNew: 1 }))) as never,
    );

    const res = await post("/routine-hooks/covan_whk_abc");

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    finish();
  });

  it("hands the run the payload and the event id", async () => {
    await post("/routine-hooks/covan_whk_abc", {
      body: '{"deploy":"finished"}',
      headers: { "X-Covan-Event-Id": "evt-1" },
    });
    await settle();

    expect(runPokedRoutine).toHaveBeenCalledOnce();
    const [, routine, trigger] = runPokedRoutine.mock.calls[0] as unknown as [
      unknown,
      typeof ROUTINE,
      { eventId: string; payload: string },
    ];
    expect(routine).toBe(ROUTINE);
    expect(trigger).toEqual({ eventId: "evt-1", payload: '{"deploy":"finished"}' });
  });

  // GitHub will not be setting ours, and most APIs settled on Idempotency-Key.
  it.each([
    ["X-Covan-Event-Id", "ours"],
    ["Idempotency-Key", "convention"],
    ["X-GitHub-Delivery", "github"],
  ])("takes the event id from %s", async (header, value) => {
    await post("/routine-hooks/covan_whk_abc", { headers: { [header]: value } });
    await settle();

    expect((runPokedRoutine.mock.calls[0] as never[])[2]).toMatchObject({ eventId: value });
  });

  it("prefers our own header when a sender sets several", async () => {
    await post("/routine-hooks/covan_whk_abc", {
      headers: { "X-Covan-Event-Id": "ours", "X-GitHub-Delivery": "theirs" },
    });
    await settle();

    expect((runPokedRoutine.mock.calls[0] as never[])[2]).toMatchObject({ eventId: "ours" });
  });

  // No id from the sender means no way to deduplicate, and nothing pretends
  // otherwise: a fresh id runs, which is what pressing an endpoint means.
  // Hashing the body instead would silently collapse two genuine, identical
  // "the deploy finished" events into one.
  it("invents an id only when the sender gave none, and a fresh one each time", async () => {
    await post("/routine-hooks/covan_whk_abc");
    await post("/routine-hooks/covan_whk_abc");
    await settle();

    const ids = runPokedRoutine.mock.calls.map((c) => (c as never[])[2] as { eventId: string });
    expect(ids[0].eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0].eventId).not.toBe(ids[1].eventId);
  });

  it("passes the token from the header ahead of the one in the path", async () => {
    await post("/routine-hooks/in-the-path", {
      headers: { "X-Covan-Ingest-Token": "in-the-header" },
    });

    expect(resolveIngestToken).toHaveBeenCalledWith(expect.anything(), "in-the-header");
  });

  it("refuses an unknown token without running anything", async () => {
    resolveIngestToken.mockResolvedValue({
      ok: false,
      status: 401,
      error: "unknown ingest token",
    });

    const res = await post("/routine-hooks/covan_whk_nope");

    expect(res.status).toBe(401);
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("passes a 409 through with the reason the caller can act on", async () => {
    resolveIngestToken.mockResolvedValue({
      ok: false,
      status: 409,
      error: "this routine is paused",
    });

    const res = await post("/routine-hooks/covan_whk_abc");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "this routine is paused" });
  });

  it("refuses a body that announces itself as too large, before reading it", async () => {
    const res = await post("/routine-hooks/covan_whk_abc", {
      headers: { "Content-Length": String(65 * 1024) },
    });

    expect(res.status).toBe(413);
    expect(resolveIngestToken).not.toHaveBeenCalled();
  });

  // Content-Length is a claim. The cap that matters is the one on the stream.
  it("refuses a body that lies about its size", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(65);
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent++ > 8) return controller.close();
        controller.enqueue(chunk);
      },
    });

    const res = await post("/routine-hooks/covan_whk_abc", {
      body,
      headers: { "Content-Length": "10" },
    });

    expect(res.status).toBe(413);
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("counts the limit against the routine rather than the caller", async () => {
    const first = { id: "r1" };
    const second = { id: "r2" };
    resolveIngestToken.mockImplementation(async (_env: unknown, token: string) => ({
      ok: true,
      routine: token.endsWith("two") ? second : first,
    }));

    const limited = { RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" };
    expect((await post("/routine-hooks/covan_whk_one", {}, limited)).status).toBe(202);
    // A different routine has its own budget, from the same address.
    expect((await post("/routine-hooks/covan_whk_two", {}, limited)).status).toBe(202);
    // The first one again, over its own limit.
    const refused = await post("/routine-hooks/covan_whk_one", {}, limited);

    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
  });

  it("notes that the trigger fired", async () => {
    await post("/routine-hooks/covan_whk_abc");
    await settle();

    expect(touchTrigger).toHaveBeenCalledWith(expect.anything(), "r1");
  });

  // The response has already gone; a failing run must not take the isolate
  // with it. The failure is recorded on routine_runs, where the owner looks.
  it("survives a run that throws", async () => {
    runPokedRoutine.mockRejectedValue(new Error("boom"));
    const res = await post("/routine-hooks/covan_whk_abc");
    await settle();

    expect(res.status).toBe(202);
    expect(touchTrigger).toHaveBeenCalled();
  });
});
