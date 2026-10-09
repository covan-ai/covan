import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createProfile,
  getProfile,
  deleteProfile,
  createBrowser,
  browserLiveUrl,
  browserState,
  stopBrowser,
  accountHeadroom,
  TAKEOVER_PROVIDER_MINUTES,
} from "./profiles";
import { createTask, type BrowserEnv } from "./client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as BrowserEnv;

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => fetchMock.mockReset());

describe("profiles", () => {
  it("creates one keyed to the Covan user", async () => {
    fetchMock.mockResolvedValue(ok({ id: "p-1", cookieDomains: [] }, 201));
    const r = await createProfile(ENV, { name: "Efe", userId: "user-1" });
    expect(r).toEqual({ kind: "ok", value: { id: "p-1", cookieDomains: [] } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.browser-use.com/api/v2/profiles");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Efe", userId: "user-1" });
  });

  it("reports the account-wide profile limit as its own status", async () => {
    fetchMock.mockResolvedValue(ok({ detail: "Profile limit exceeded" }, 402));
    const r = await createProfile(ENV, { userId: "user-1" });
    expect(r.kind).toBe("error");
    expect((r as { status: number }).status).toBe(402);
  });

  it("reads cookie domains back, which is the only thing a screen may show", async () => {
    fetchMock.mockResolvedValue(ok({ id: "p-1", cookieDomains: ["mail.google.com"] }));
    const r = await getProfile(ENV, "p-1");
    expect((r as { value: { cookieDomains: string[] } }).value.cookieDomains).toEqual([
      "mail.google.com",
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.browser-use.com/api/v2/profiles/p-1");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("deletes one, which is what makes a per-person profile forgettable", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const r = await deleteProfile(ENV, "p-1");
    expect(r.kind).toBe("ok");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.browser-use.com/api/v2/profiles/p-1");
  });
});

describe("createBrowser", () => {
  it("asks for a browser on the profile, with our own timeout", async () => {
    fetchMock.mockResolvedValue(
      ok({ id: "s-1", status: "active", liveUrl: "https://live.browser-use.com/x", cdpUrl: "wss://secret", timeoutAt: "2026-10-10T10:15:00Z" }, 201),
    );
    const r = await createBrowser(ENV, { profileId: "p-1", proxyCountryCode: "de" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      profileId: "p-1",
      timeout: TAKEOVER_PROVIDER_MINUTES,
      proxyCountryCode: "de",
      // A recording of this browser is a video of somebody typing a password.
      enableRecording: false,
    });
    expect((r as { value: { liveUrl: string } }).value.liveUrl).toBe("https://live.browser-use.com/x");
  });

  /**
   * The structural half of "cdpUrl is never returned". A field no function
   * constructs is a field no log line can print.
   */
  it("never constructs cdpUrl", async () => {
    fetchMock.mockResolvedValue(ok({ id: "s-1", status: "active", liveUrl: "u", cdpUrl: "wss://secret" }, 201));
    const r = await createBrowser(ENV, { profileId: "p-1" });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("cdpUrl");
  });

  it("withholds the provider body on a failure, because it carries a profile id", async () => {
    fetchMock.mockResolvedValue(ok({ detail: "profileId p-1 is not valid" }, 422));
    const r = await createBrowser(ENV, { profileId: "p-1" });
    expect((r as { message: string }).message).not.toContain("p-1");
    expect((r as { message: string }).message).toContain("422");
  });
});

describe("browserLiveUrl", () => {
  it("re-reads a live browser's url for its owner", async () => {
    fetchMock.mockResolvedValue(
      ok({
        id: "s-1",
        status: "active",
        liveUrl: "https://live.browser-use.com/x",
        cdpUrl: "wss://secret",
        timeoutAt: "2026-10-10T10:15:00Z",
      }),
    );
    const r = await browserLiveUrl(ENV, "s-1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.browser-use.com/api/v2/browsers/s-1");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect((r as { value: { liveUrl: string } }).value.liveUrl).toBe(
      "https://live.browser-use.com/x",
    );
  });

  /**
   * The same structural claim as `createBrowser`'s equivalent test, for the
   * one other function authorized to parse this credential.
   */
  it("never constructs cdpUrl", async () => {
    fetchMock.mockResolvedValue(ok({ id: "s-1", status: "active", liveUrl: "u", cdpUrl: "wss://secret" }));
    const r = await browserLiveUrl(ENV, "s-1");
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("cdpUrl");
  });

  it("withholds the provider body on a failure, because the request named a session", async () => {
    fetchMock.mockResolvedValue(ok({ detail: "session s-1 has no profile p-1 attached" }, 404));
    const r = await browserLiveUrl(ENV, "s-1");
    expect((r as { message: string }).message).not.toContain("p-1");
    expect((r as { message: string }).message).toContain("404");
  });
});

describe("browserState and stopBrowser", () => {
  it("parse nothing a log line could leak", async () => {
    for (const fn of [browserState, stopBrowser]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(ok({ id: "s-1", status: "stopped", liveUrl: "https://live/x", cdpUrl: "wss://secret" }));
      const r = await fn(ENV, "s-1");
      expect(r).toEqual({ kind: "ok", value: { id: "s-1", status: "stopped" } });
    }
  });

  it("stops with the provider's own action word", async () => {
    fetchMock.mockResolvedValue(ok({ id: "s-1", status: "stopped" }));
    await stopBrowser(ENV, "s-1");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "stop" });
  });
});

describe("accountHeadroom", () => {
  it("reads the shared pool so a takeover can refuse before taking a slot", async () => {
    fetchMock.mockResolvedValue(ok({ concurrentSessionLimit: 10, activeSessionCount: 7 }));
    const r = await accountHeadroom(ENV);
    expect(r).toEqual({ kind: "ok", value: { active: 7, limit: 10 } });
  });
});

describe("createTask with a profile", () => {
  it("attaches the profile through sessionSettings", async () => {
    fetchMock.mockResolvedValue(ok({ id: "t-1", sessionId: "s-1" }, 202));
    await createTask(ENV, { task: "read my invoices", profileId: "p-1", proxyCountryCode: "de" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionSettings).toEqual({ profileId: "p-1", proxyCountryCode: "de" });
    // Unchanged and permanent: no credential ever goes in a task.
    expect(body.secrets).toBeUndefined();
    expect(body.opVaultId).toBeUndefined();
  });

  it("sends no sessionSettings at all when there is no profile", async () => {
    fetchMock.mockResolvedValue(ok({ id: "t-1", sessionId: "s-1" }, 202));
    await createTask(ENV, { task: "read a public page" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).sessionSettings).toBeUndefined();
  });

  it("withholds the provider body only when a profile was attached", async () => {
    fetchMock.mockResolvedValue(ok({ detail: "bad sessionSettings profileId p-1" }, 422));
    const withProfile = await createTask(ENV, { task: "x".repeat(12), profileId: "p-1" });
    expect((withProfile as { message: string }).message).not.toContain("p-1");

    fetchMock.mockResolvedValue(ok({ detail: "task too short" }, 422));
    const without = await createTask(ENV, { task: "x".repeat(12) });
    expect((without as { message: string }).message).toContain("task too short");
  });
});
