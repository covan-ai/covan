import { describe, it, expect, vi } from "vitest";
import {
  composioConfigured,
  createLink,
  executeTool,
  getConnectedAccount,
  searchTools,
  statusOf,
  type ComposioEnv,
} from "./client";

/**
 * The four JSON endpoints Covan uses, and the defensive reading around them.
 *
 * Most of what is asserted here is tolerance of shape: Composio has spelled the
 * list wrapper `items` and `data` at different versions, and a toolkit as a
 * string, as `{slug}` and as `{name}`. A field name that is load-bearing across
 * a version bump is a thing to notice, not a thing to assume — `toolkit` in
 * particular decides whether `run_tool` will accept a slug at all.
 */
const ENV: ComposioEnv = { COMPOSIO_API_KEY: "ck_test" };

function fetchReturning(body: unknown, status = 200) {
  // The parameters are declared so `mock.calls` is typed as the pair this file
  // asserts on — a zero-argument fake records a zero-length tuple.
  return vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
}

describe("composioConfigured", () => {
  it("is the one question every surface asks, so chat and a schedule agree", () => {
    expect(composioConfigured({})).toBe(false);
    expect(composioConfigured(ENV)).toBe(true);
  });
});

describe("searchTools", () => {
  it("sends the API key as Composio's own header and never as Authorization", async () => {
    const fetchImpl = fetchReturning({ items: [] });
    await searchTools(ENV, { search: "send mail" }, { fetchImpl: fetchImpl as never });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ck_test");
    expect(headers.Authorization).toBeUndefined();
    expect(init.redirect).toBe("manual");
  });

  it("reads a list whether it arrives as items or as data", async () => {
    const row = { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } };
    for (const body of [{ items: [row] }, { data: [row] }, [row]]) {
      const out = await searchTools(
        ENV,
        { search: "x" },
        { fetchImpl: fetchReturning(body) as never },
      );
      expect(out.kind === "ok" && out.tools[0].slug).toBe("GMAIL_SEND_EMAIL");
      expect(out.kind === "ok" && out.tools[0].toolkit).toBe("gmail");
    }
  });

  it("falls back to the slug's own prefix when no toolkit is named", async () => {
    // A convention rather than a promise, which is why it is the last resort:
    // `run_tool` compares this to the connection's toolkit before it will send
    // anything, so getting it wrong means a refusal rather than a wrong call.
    const out = await searchTools(
      ENV,
      { search: "x" },
      { fetchImpl: fetchReturning({ items: [{ slug: "LINEAR_CREATE_ISSUE" }] }) as never },
    );
    expect(out.kind === "ok" && out.tools[0].toolkit).toBe("linear");
  });

  it("says nothing about read or write when Composio says nothing", async () => {
    const out = await searchTools(
      ENV,
      { search: "x" },
      { fetchImpl: fetchReturning({ items: [{ slug: "GMAIL_SEND_EMAIL" }] }) as never },
    );
    // Null rather than a guess. Nothing in the permission model branches on it.
    expect(out.kind === "ok" && out.tools[0].destructive).toBeNull();
  });

  it("refuses without a key rather than making an unauthenticated request", async () => {
    const fetchImpl = fetchReturning({ items: [] });
    const out = await searchTools({}, { search: "x" }, { fetchImpl: fetchImpl as never });
    expect(out).toMatchObject({ kind: "error", status: 501 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards the far end's own body on a failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota exceeded", { status: 402 }));
    const out = await searchTools(ENV, { search: "x" }, { fetchImpl: fetchImpl as never });
    expect(out).toMatchObject({ kind: "error", status: 402 });
    expect(out.kind === "error" && out.message).toContain("quota exceeded");
  });

  it("treats a redirect as an error rather than following it", async () => {
    // Every 3xx, for `lib/routines/delivery.ts`'s reason: a redirect is a
    // request to repeat a credentialed call somewhere we did not name.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
    const out = await searchTools(ENV, { search: "x" }, { fetchImpl: fetchImpl as never });
    expect(out.kind).toBe("error");
  });
});

describe("executeTool", () => {
  it("carries both identifiers in the body, as the caller gave them", async () => {
    const fetchImpl = fetchReturning({ successful: true });
    await executeTool(
      ENV,
      {
        slug: "GMAIL_SEND_EMAIL",
        connectedAccountId: "ca_1",
        userId: "cu_1",
        arguments: { subject: "hi" },
      },
      { fetchImpl: fetchImpl as never },
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v3/tools/execute/GMAIL_SEND_EMAIL");
    expect(JSON.parse(String(init.body))).toEqual({
      connected_account_id: "ca_1",
      user_id: "cu_1",
      arguments: { subject: "hi" },
    });
  });
});

describe("createLink", () => {
  it("returns both halves, and refuses an answer missing either", async () => {
    const ok = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1" },
      {
        fetchImpl: fetchReturning({ id: "ca_1", redirect_url: "https://consent.test/x" }) as never,
      },
    );
    expect(ok).toMatchObject({
      kind: "ok",
      connectedAccountId: "ca_1",
      redirectUrl: "https://consent.test/x",
    });

    // A link with no account id would produce a row that cannot be polled and
    // cannot be revoked — the exact shape `lib/composio/revoke.ts` exists to
    // prevent.
    const half = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1" },
      { fetchImpl: fetchReturning({ redirect_url: "https://consent.test/x" }) as never },
    );
    expect(half.kind).toBe("error");
  });
});

describe("statusOf", () => {
  it("maps Composio's vocabulary onto tool_connections.status", async () => {
    expect(statusOf("ACTIVE")).toBe("active");
    expect(statusOf("FAILED")).toBe("failed");
    expect(statusOf("EXPIRED")).toBe("failed");
    // Anything unrecognised stays pending, which is the forgiving direction: a
    // new status name should leave a half-finished connection polling rather
    // than mark a live grant broken.
    expect(statusOf("SOMETHING_NEW")).toBe("pending");
    expect(statusOf("")).toBe("pending");

    const asked = await getConnectedAccount(ENV, "ca_1", {
      fetchImpl: fetchReturning({ data: { status: "ACTIVE" } }) as never,
    });
    expect(asked).toMatchObject({ kind: "ok", status: "active" });
  });
});
