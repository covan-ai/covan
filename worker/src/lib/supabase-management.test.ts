import { describe, it, expect, vi, beforeEach } from "vitest";
import { listProjects, readOnlyQueryUrl, MANAGEMENT_BASE } from "./supabase-management";

/**
 * The thin client for Supabase's own Management API.
 *
 * Two callers, one shape: the route that connects an account lists projects
 * with it, and `query_database` builds its URL with it. What is deliberately
 * NOT here is the query fetch itself — that stays in the tool, where the
 * origin guard, the byte cap and the turn's abort signal already live.
 */
const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

beforeEach(() => {
  fetchMock.mockReset();
});

describe("listProjects", () => {
  it("asks the management API with the token as a bearer", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ref: "abcdefghijklmnop",
            name: "covan-prod",
            region: "eu-central-1",
            status: "ACTIVE_HEALTHY",
          },
        ]),
        { status: 200 },
      ),
    );

    const result = await listProjects("sbp_token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.supabase.com/v1/projects");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sbp_token");
    expect(result).toEqual({
      kind: "ok",
      projects: [
        {
          ref: "abcdefghijklmnop",
          name: "covan-prod",
          region: "eu-central-1",
          status: "ACTIVE_HEALTHY",
        },
      ],
    });
  });

  it("reports a rejected token instead of throwing", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Unauthorized"}', { status: 401 }));

    const result = await listProjects("sbp_wrong");

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected an error result");
    expect(result.status).toBe(401);
    expect(result.message.toLowerCase()).toContain("token");
  });

  it("leaves out an entry with no project ref", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ name: "half a project" }, { ref: "r", name: "n" }]), {
        status: 200,
      }),
    );

    const result = await listProjects("sbp_token");

    if (result.kind !== "ok") throw new Error("expected projects");
    expect(result.projects.map((p) => p.ref)).toEqual(["r"]);
  });
});

describe("readOnlyQueryUrl", () => {
  it("points at the project's read-only query endpoint", () => {
    expect(readOnlyQueryUrl(MANAGEMENT_BASE, "abcdefghijklmnop")).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnop/database/query/read-only",
    );
  });

  it("encodes a ref rather than letting it reshape the path", () => {
    expect(readOnlyQueryUrl(MANAGEMENT_BASE, "a/b")).toContain("/projects/a%2Fb/database");
  });
});
