import { describe, it, expect, vi } from "vitest";
import { fetchSource } from "./source";
import type { Cursor } from "./feed";

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
