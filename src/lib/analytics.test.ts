import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { events, getAccessToken } = vi.hoisted(() => ({
  events: vi.fn(),
  getAccessToken: vi.fn(async () => "tok"),
}));
vi.mock("./api-client", () => ({
  api: { onboarding: { events } },
  getAccessToken,
}));

import {
  _resetAnalytics,
  flushEvents,
  installUnloadFlush,
  pendingEvents,
  trackStep,
} from "./analytics";

beforeEach(() => {
  _resetAnalytics();
  events.mockReset();
  events.mockResolvedValue({ accepted: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackStep", () => {
  it("queues what happened, with an id the server can dedupe on", () => {
    trackStep("intro:apps", "viewed");
    trackStep("intro:apps", "completed");

    const queued = pendingEvents();
    expect(queued.map((e) => e.event)).toEqual(["viewed", "completed"]);
    expect(queued[0].step).toBe("intro:apps");
    expect(queued[0].clientId).toMatch(/[0-9a-f-]{36}/);
    expect(queued[0]).not.toHaveProperty("elapsedMs");
    // Finished after being seen: the gap is how long the screen was open.
    expect(queued[1].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the queue to a hundred, dropping the oldest", () => {
    for (let i = 0; i < 105; i++) trackStep(`s${i}`, "viewed");
    const queued = pendingEvents();
    expect(queued).toHaveLength(100);
    expect(queued[0].step).toBe("s5");
  });
});

describe("flushEvents", () => {
  it("sends the batch once and clears it", async () => {
    trackStep("assistant", "viewed");
    await flushEvents();
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][0]).toHaveLength(1);
    expect(pendingEvents()).toHaveLength(0);

    await flushEvents();
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("puts a failed batch back once, and then lets it go", async () => {
    events.mockRejectedValueOnce(new Error("offline"));
    trackStep("tools", "viewed");
    await flushEvents();
    expect(pendingEvents()).toHaveLength(1);

    events.mockRejectedValueOnce(new Error("still offline"));
    await flushEvents();
    expect(pendingEvents()).toHaveLength(0);
  });

  it("goes out with the page, carrying the token, when the page is going away", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    trackStep("purpose", "viewed");
    await Promise.resolve();

    await flushEvents({ unloading: true });

    expect(events).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string).events).toHaveLength(1);
  });
});

describe("installUnloadFlush", () => {
  it("flushes on pagehide and stops listening when uninstalled", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const uninstall = installUnloadFlush();
    trackStep("mode", "viewed");
    await Promise.resolve();

    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    uninstall();
    trackStep("mode", "completed");
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
