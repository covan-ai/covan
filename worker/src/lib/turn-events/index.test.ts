import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

const deferredSpy = vi.fn();
vi.mock("../defer", () => ({
  deferred: (c: unknown, promise: Promise<unknown>) => {
    deferredSpy(c, promise);
    // The real one logs a rejection and moves on; so does this.
    promise.catch(() => {});
  },
}));

import {
  forgetTurnObservers,
  hasTurnObservers,
  observeTurn,
  registerTurnObserver,
  type TurnEvent,
} from "./index";

const DB = { tag: "the caller's own client" };
const c = { get: (key: string) => (key === "db" ? DB : undefined) } as unknown as Context;

const EVENT: TurnEvent = {
  kind: "question_edited",
  workspaceId: "ws-1",
  userId: "user-1",
  agentId: null,
  sessionId: "sess-1",
  messageId: "msg-1",
};

afterEach(() => {
  forgetTurnObservers();
  deferredSpy.mockClear();
  vi.restoreAllMocks();
});

describe("observeTurn", () => {
  it("does nothing, and defers nothing, when no observer is registered", () => {
    observeTurn(c, EVENT);
    expect(deferredSpy).not.toHaveBeenCalled();
  });

  it("hands a registered observer the event and the caller's own client", async () => {
    const seen = vi.fn();
    registerTurnObserver(seen);

    observeTurn(c, EVENT);
    await deferredSpy.mock.calls[0][1];

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(EVENT, DB);
  });

  it("runs observers past the response, through `deferred`", () => {
    registerTurnObserver(() => {});
    registerTurnObserver(() => {});

    observeTurn(c, EVENT);

    expect(deferredSpy).toHaveBeenCalledTimes(1);
    expect(deferredSpy.mock.calls[0][0]).toBe(c);
  });

  it("runs every registered observer", async () => {
    const first = vi.fn();
    const second = vi.fn();
    registerTurnObserver(first);
    registerTurnObserver(second);

    observeTurn(c, EVENT);
    await deferredSpy.mock.calls[0][1];

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("logs an observer that throws, and still runs the next one", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    registerTurnObserver(() => {
      throw new Error("boom");
    });
    registerTurnObserver(after);

    expect(() => observeTurn(c, EVENT)).not.toThrow();
    await deferredSpy.mock.calls[0][1];

    expect(log).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("logs an observer that rejects", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    registerTurnObserver(async () => {
      throw new Error("later");
    });

    observeTurn(c, EVENT);
    await expect(deferredSpy.mock.calls[0][1]).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
  });

  it("does not wait for an observer before returning", () => {
    registerTurnObserver(() => new Promise(() => {}));
    expect(observeTurn(c, EVENT)).toBeUndefined();
  });

  it("builds an event given as a function with the observers' work, once", async () => {
    const seen = vi.fn();
    registerTurnObserver(seen);
    const build = vi.fn(async () => EVENT);

    observeTurn(c, build);
    await deferredSpy.mock.calls[0][1];

    expect(build).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(EVENT, DB);
  });

  it("drops an event that a function answers with null", async () => {
    const seen = vi.fn();
    registerTurnObserver(seen);

    observeTurn(c, () => null);
    await deferredSpy.mock.calls[0][1];

    expect(seen).not.toHaveBeenCalled();
  });

  it("logs a function that throws, and the request is unaffected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = vi.fn();
    registerTurnObserver(seen);

    expect(() =>
      observeTurn(c, () => {
        throw new Error("no session");
      }),
    ).not.toThrow();
    await deferredSpy.mock.calls[0][1];

    expect(log).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
  });

  it("builds nothing when no observer is registered", () => {
    const build = vi.fn(() => EVENT);
    observeTurn(c, build);
    expect(build).not.toHaveBeenCalled();
  });

  it("says whether anything is registered", () => {
    expect(hasTurnObservers()).toBe(false);
    registerTurnObserver(() => {});
    expect(hasTurnObservers()).toBe(true);
  });

  it("forgets what was registered", () => {
    registerTurnObserver(() => {});
    forgetTurnObservers();
    expect(hasTurnObservers()).toBe(false);

    observeTurn(c, EVENT);

    expect(deferredSpy).not.toHaveBeenCalled();
  });
});
