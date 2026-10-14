import { describe, it, expect, vi } from "vitest";
import { fetchSource, pinnedRequest } from "./source";
import type { Cursor } from "./feed";

// Task 11 wires a real DNS lookup into the Node fetch path so a hostname that
// merely resolves to a private address is still caught. That lookup is a
// dynamic `import("node:dns/promises")`, which vi.mock intercepts the same as
// a static one. Stub it so these tests keep exercising fixture hostnames like
// "e.com" without depending on a real network round trip — the same reason
// fetchImpl itself is mocked rather than left to hit the network.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const OWN = ["api.example.com"];
const cursorWith = (etag: string | null, contentHash: string | null = null): Cursor => ({
  seenKeys: [],
  lastPublishedAt: null,
  etag,
  contentHash,
});

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>x1</id><title>One</title><link href="https://e.com/1"/>
  <updated>2026-08-14T10:00:00Z</updated><summary>s</summary></entry></feed>`;

// Node's Response constructor enforces the null-body-status list (304 among
// them) and throws if given a body at all, even "". Status 304 never carries
// a body in practice, so pass null for it and leave every other case as-is.
const res = (body: string, init: ResponseInit = {}) =>
  new Response(init.status === 304 ? null : body, init);

describe("fetchSource", () => {
  it("sends the stored etag and reports unchanged on 304 without parsing", async () => {
    const fetchImpl = vi.fn(async () => res("", { status: 304 }));
    const out = await fetchSource(
      { source_kind: "rss", source_config: { url: "https://e.com/feed" } },
      cursorWith('W/"abc"'),
      { fetchImpl: fetchImpl as unknown as typeof fetch, ownHosts: OWN },
    );
    expect(out).toEqual({ status: "unchanged" });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(call[1].headers);
    expect(headers.get("If-None-Match")).toBe('W/"abc"');
  });

  it("parses a feed and returns its items plus the new etag", async () => {
    const fetchImpl = vi.fn(async () => res(ATOM, { status: 200, headers: { ETag: '"v2"' } }));
    const out = await fetchSource(
      { source_kind: "rss", source_config: { url: "https://e.com/feed" } },
      null,
      { fetchImpl: fetchImpl as unknown as typeof fetch, ownHosts: OWN },
    );
    expect(out).toMatchObject({ status: "items", etag: '"v2"' });
    if (out.status !== "items") throw new Error("unreachable");
    expect(out.items.map((i) => i.key)).toEqual(["x1"]);
  });

  it("hashes a watched page and reports unchanged when the hash matches", async () => {
    const fetchImpl = vi.fn(async () => res("<html>same</html>", { status: 200 }));
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, ownHosts: OWN };
    const firstOut = await fetchSource(
      { source_kind: "web", source_config: { url: "https://e.com/p" } },
      null,
      deps,
    );
    if (firstOut.status !== "content") throw new Error("unreachable");
    const secondOut = await fetchSource(
      { source_kind: "web", source_config: { url: "https://e.com/p" } },
      cursorWith(null, firstOut.hash),
      deps,
    );
    expect(secondOut).toEqual({ status: "unchanged" });
  });

  it("does not touch the network for a sourceless routine", async () => {
    const fetchImpl = vi.fn();
    const out = await fetchSource({ source_kind: "none", source_config: {} }, null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ownHosts: OWN,
    });
    expect(out).toEqual({ status: "items", items: [], etag: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-validates a redirect target instead of following it blindly", async () => {
    const fetchImpl = vi.fn(async () =>
      res("", { status: 302, headers: { Location: "http://169.254.169.254/meta" } }),
    );
    await expect(
      fetchSource({ source_kind: "web", source_config: { url: "https://e.com/p" } }, null, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ownHosts: OWN,
      }),
    ).rejects.toThrow(/unsafe url/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a safe redirect", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res("", { status: 301, headers: { Location: "https://e.com/final" } }))
      .mockResolvedValueOnce(res(ATOM, { status: 200 }));
    const out = await fetchSource(
      { source_kind: "rss", source_config: { url: "https://e.com/feed" } },
      null,
      { fetchImpl: fetchImpl as unknown as typeof fetch, ownHosts: OWN },
    );
    expect(out.status).toBe("items");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than chasing a redirect loop", async () => {
    const fetchImpl = vi.fn(async () =>
      res("", { status: 302, headers: { Location: "https://e.com/loop" } }),
    );
    await expect(
      fetchSource({ source_kind: "rss", source_config: { url: "https://e.com/loop" } }, null, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ownHosts: OWN,
      }),
    ).rejects.toThrow(/too many redirects/);
  });

  it("refuses a body larger than the cap", async () => {
    const fetchImpl = vi.fn(async () => res("x".repeat(500), { status: 200 }));
    await expect(
      fetchSource({ source_kind: "web", source_config: { url: "https://e.com/big" } }, null, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ownHosts: OWN,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/too large/);
  });

  it("rejects a source url that fails the guard", async () => {
    await expect(
      fetchSource({ source_kind: "rss", source_config: { url: "http://127.0.0.1/f" } }, null, {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        ownHosts: OWN,
      }),
    ).rejects.toThrow(/unsafe url/);
  });

  it("surfaces an upstream error status", async () => {
    const fetchImpl = vi.fn(async () => res("boom", { status: 500 }));
    await expect(
      fetchSource({ source_kind: "rss", source_config: { url: "https://e.com/f" } }, null, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ownHosts: OWN,
      }),
    ).rejects.toThrow(/upstream 500/);
  });
});

describe("pinnedRequest", () => {
  // Checking what a name resolves to is half of it; `fetch` resolves again to
  // connect, and DNS may answer differently the second time. On Bun the
  // request goes to the checked address, carrying the real name.
  it("connects to the checked address and speaks to the chosen host", () => {
    const [url, init] = pinnedRequest(
      new URL("https://feeds.example.com:8443/rss?x=1"),
      "93.184.216.34",
      {
        method: "GET",
        headers: { "User-Agent": "covan-routines/1.0" },
      },
    );

    expect(url).toBe("https://93.184.216.34:8443/rss?x=1");
    const headers = new Headers(init.headers);
    expect(headers.get("Host")).toBe("feeds.example.com:8443");
    expect(headers.get("User-Agent")).toBe("covan-routines/1.0");
    // Bun's fetch takes the TLS server name from here, for SNI and for the
    // certificate check, so the pin is verified against the chosen name.
    expect((init as { tls?: { serverName?: string } }).tls?.serverName).toBe("feeds.example.com");
  });

  it("brackets an IPv6 address", () => {
    const [url] = pinnedRequest(new URL("http://feeds.example.com/rss"), "2606:4700::1", {});
    expect(url).toBe("http://[2606:4700::1]/rss");
  });

  it("names no TLS server for plain http", () => {
    const [, init] = pinnedRequest(new URL("http://feeds.example.com/"), "93.184.216.34", {});
    expect((init as { tls?: unknown }).tls).toBeUndefined();
  });

  it("leaves the request alone with nothing to pin to", () => {
    const init = { method: "POST" };
    expect(pinnedRequest(new URL("https://feeds.example.com/"), null, init)).toEqual([
      "https://feeds.example.com/",
      init,
    ]);
    // An IP literal was checked as written; there is no second lookup to race.
    expect(pinnedRequest(new URL("https://93.184.216.34/"), "93.184.216.34", init)[0]).toBe(
      "https://93.184.216.34/",
    );
  });
});
