import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";
import { httpRequestTool, resolveTarget } from "./http-request";

/**
 * The tool that lets a model choose an endpoint, and the three things that
 * keep that from being reckless: the origin is locked, the methods are a
 * person's decision, and every 3xx is refused.
 *
 * `authHeaders` is mocked because the credential path has its own home
 * (`lib/harness/secrets.ts`) and its own reason to exist — asking the
 * database for permission before reaching past it. Re-proving that here
 * would be testing a different file through this one.
 */
const authHeaders = vi.fn(async () => ({ Authorization: "Bearer t" }));
vi.mock("../secrets", () => ({ authHeaders: () => authHeaders() }));

/**
 * The resolving half of the SSRF guard, stubbed — and asserted on instead.
 *
 * It is a real DNS lookup on the Node runtime, which is exactly what makes it
 * worth having and exactly what makes it untestable here: `api.example.com`
 * does not resolve, so every case would fail for the wrong reason. What
 * matters is that it is called on the host that is about to be fetched, and
 * that is what the spy checks.
 */
const resolvesPublicly = vi.fn(async (_host: string) => {});
vi.mock("../../routines/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routines/source")>();
  return { ...actual, resolvesPublicly: (host: string) => resolvesPublicly(host) };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Orders API",
  transport: "http",
  base_url: "https://api.example.com/v1",
  auth_kind: "static_header",
  allowed_methods: ["GET"],
  config: {},
};

function ctxWith(row: Record<string, unknown> | null = CONNECTION): ToolContext {
  return {
    db: {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        }),
      }),
    } as unknown as ToolContext["db"],
    env: { ALLOWED_ORIGIN: "https://app.covan.test", ROUTINE_SECRET_KEY: "k" } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  authHeaders.mockClear();
  resolvesPublicly.mockClear();
  resolvesPublicly.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue(
    new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } }),
  );
});

describe("resolveTarget", () => {
  it("hangs the path off the base path rather than off the origin", () => {
    const out = resolveTarget("https://api.example.com/v1", "/orders");
    expect(out).toEqual({ ok: true, url: new URL("https://api.example.com/v1/orders") });
  });

  it("refuses a full URL, which is how a model would leave the origin", () => {
    expect(resolveTarget("https://api.example.com", "https://evil.test/x")).toMatchObject({
      ok: false,
    });
  });

  it("refuses a protocol-relative path, which replaces the host", () => {
    expect(resolveTarget("https://api.example.com", "//evil.test/x")).toMatchObject({ ok: false });
  });

  it("refuses a path that climbs above the base path", () => {
    expect(resolveTarget("https://api.example.com/v1", "/../admin")).toMatchObject({ ok: false });
  });

  it("refuses a bare path with no leading slash", () => {
    expect(resolveTarget("https://api.example.com", "orders")).toMatchObject({ ok: false });
  });
});

describe("http_request", () => {
  it("calls the resolved URL and hands the body back", async () => {
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/orders", query: { limit: "5" } },
      ctxWith(),
    );
    expect(result).toEqual({ kind: "ok", content: '{"ok":true}' });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/v1/orders?limit=5");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t");
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    // Checked at call time, not only when the connection was created: a
    // hostname that answered with a public address in March can answer with
    // 169.254.169.254 in September.
    expect(resolvesPublicly).toHaveBeenCalledWith("api.example.com");
  });

  it("refuses a method the team did not allow, and says not to retry", async () => {
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "DELETE", path: "/orders/1" },
      ctxWith(),
    );
    expect(result).toMatchObject({ kind: "error" });
    expect((result as { message: string }).message).toContain("not allowed");
    expect((result as { message: string }).message).toContain("Do not retry");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a connection that is a database, rather than guessing", async () => {
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith({ ...CONNECTION, transport: "sql" }),
    );
    expect((result as { message: string }).message).toContain("query_database");
  });

  it("refuses a connection in another workspace, which reads as absent", async () => {
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith(null),
    );
    expect(result).toEqual({ kind: "error", message: "no such connection in this workspace" });
  });

  it("goes through the SSRF guard, so a private base URL never reaches fetch", async () => {
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith({ ...CONNECTION, base_url: "http://169.254.169.254" }),
    );
    expect((result as { message: string }).message).toContain("private address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to be pointed back at this service", async () => {
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith({ ...CONNECTION, base_url: "https://app.covan.test" }),
    );
    expect((result as { message: string }).message).toContain("this service");
  });

  it("treats every redirect as an error rather than following it", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }),
    );
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith(),
    );
    expect((result as { message: string }).message).toContain("not followed");
  });

  it("gives the model the failing body, which is what tells it how to fix the call", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"unknown field emial"}', { status: 400, statusText: "Bad Request" }),
    );
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith(),
    );
    expect((result as { message: string }).message).toContain("unknown field emial");
  });

  it("caps what it reads, so a hostile endpoint cannot exhaust the worker", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(400 * 1024), { status: 200 }));
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith(),
    );
    expect((result as { message: string }).message).toContain("too large");
  });

  it("refuses a host that resolves into private space, on the runtime that can tell", async () => {
    resolvesPublicly.mockRejectedValue(new Error("unsafe url: resolves to 10.0.0.1"));
    const result = await httpRequestTool.run(
      { connectionId: "conn-1", method: "GET", path: "/x" },
      ctxWith(),
    );
    expect((result as { message: string }).message).toContain("10.0.0.1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable on a deployment with no origin list to check against", () => {
    expect(httpRequestTool.isConfigured({} as ToolEnv)).toBe(false);
  });
});
