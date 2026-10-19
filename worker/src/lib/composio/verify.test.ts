import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyConnection } from "./verify";

const env = { COMPOSIO_API_KEY: "ck_test" };
const row = { id: "conn-1", toolkitSlug: "posthog", connectedAccountId: "ca_1" };

/** Composio, answering the toolkit read and then the proxied "who am I". */
function composio(
  toolkit: Record<string, unknown>,
  proxied: { status: number; body: unknown } | "absent",
) {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v3.1/toolkits/posthog")) {
      return new Response(JSON.stringify({ slug: "posthog", name: "PostHog", ...toolkit }));
    }
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        connected_account_id: "ca_1",
        endpoint: "/api/users/@me/",
        method: "GET",
      });
      if (proxied === "absent") return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ status: proxied.status, data: proxied.body }));
    }
    throw new Error(`unexpected ${url}`);
  });
  return impl as unknown as typeof fetch;
}

function recordingDb() {
  const writes: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      update: (values: Record<string, unknown>) => {
        writes.push(values);
        return { eq: async () => ({ error: null }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { db, writes };
}

const WHO_AM_I = { get_current_user_endpoint: "/api/users/@me/" };

describe("verifyConnection", () => {
  it("warns with the provider's own words when it refuses the key", async () => {
    const { db, writes } = recordingDb();
    const fetchImpl = composio(WHO_AM_I, {
      status: 401,
      body: { detail: "Personal API key found in request Authorization header is invalid." },
    });

    await expect(verifyConnection(env, db, row, { fetchImpl })).resolves.toBe("refused");
    expect(writes).toEqual([
      {
        verified_at: null,
        verify_error:
          "PostHog refused this credential: Personal API key found in request Authorization header is invalid.",
      },
    ]);
  });

  it("names the status when the provider gives no reason", async () => {
    const { db, writes } = recordingDb();
    await verifyConnection(env, db, row, {
      fetchImpl: composio(WHO_AM_I, { status: 403, body: null }),
    });
    expect(writes[0].verify_error).toBe("PostHog refused this credential (HTTP 403).");
  });

  it("records a key that works, and clears an earlier warning", async () => {
    const { db, writes } = recordingDb();
    await expect(
      verifyConnection(env, db, row, {
        fetchImpl: composio(WHO_AM_I, { status: 200, body: { id: 1 } }),
      }),
    ).resolves.toBe("verified");
    expect(writes).toHaveLength(1);
    expect(writes[0].verify_error).toBeNull();
    expect(typeof writes[0].verified_at).toBe("string");
  });

  // 0072: a check with false negatives must never mark a working connection
  // broken, so every answer that is not a clear yes or no writes nothing.
  it.each([
    ["the catalogue names no endpoint", {}, { status: 401, body: null }],
    [
      "the endpoint is not a read",
      { ...WHO_AM_I, get_current_user_endpoint_method: "POST" },
      { status: 401, body: null },
    ],
    ["the provider answers 404", WHO_AM_I, { status: 404, body: null }],
    ["the provider answers 500", WHO_AM_I, { status: 500, body: null }],
    ["the proxy itself fails", WHO_AM_I, "absent" as const],
  ])("writes nothing when %s", async (_why, toolkit, proxied) => {
    const { db, writes } = recordingDb();
    await expect(
      verifyConnection(env, db, row, { fetchImpl: composio(toolkit, proxied) }),
    ).resolves.toBe("unknown");
    expect(writes).toEqual([]);
  });

  it("never throws", async () => {
    const { db } = recordingDb();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(verifyConnection(env, db, row, { fetchImpl })).resolves.toBe("unknown");
    spy.mockRestore();
  });
});
