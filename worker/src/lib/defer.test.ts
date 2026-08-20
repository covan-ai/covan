import { describe, it, expect, vi } from "vitest";
import type { Context } from "hono";
import { deferred } from "./defer";

describe("deferred", () => {
  it("hands the promise to waitUntil when an execution context exists", async () => {
    const waitUntil = vi.fn();
    const c = { executionCtx: { waitUntil } } as unknown as Context;

    deferred(c, Promise.resolve("done"));

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("still runs the promise when there is no execution context", async () => {
    const c = {
      get executionCtx(): never {
        throw new Error("This context has no ExecutionContext");
      },
    } as unknown as Context;

    let ran = false;
    deferred(
      c,
      Promise.resolve().then(() => {
        ran = true;
      }),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
  });

  it("swallows and logs a rejection instead of becoming an unhandled rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = {
      get executionCtx(): never {
        throw new Error("no ctx");
      },
    } as unknown as Context;

    deferred(c, Promise.reject(new Error("boom")));

    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
